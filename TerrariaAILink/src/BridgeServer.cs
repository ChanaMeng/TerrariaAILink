using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Terraria;

namespace TerrariaAILink
{
	/// <summary>One tick of input. Aim is a tile offset from the player center; NaN means "leave the mouse alone".</summary>
	public sealed class InputFrame
	{
		public long Tick;
		public bool Left, Right, Up, Down, Jump, UseItem, UseTile;
		public int Slot = -1;
		public float AimX = float.NaN;
		public float AimY = float.NaN;
		public bool HasAim => !float.IsNaN(AimX) && !float.IsNaN(AimY);
	}

	/// <summary>NDJSON bridge on 127.0.0.1. Network threads only touch bytes and queues; Terraria objects stay on the main thread.</summary>
	public sealed class BridgeServer
	{
		public const int DefaultPort = 17890;
		public const int ProtocolVersion = 1;

		public readonly int Port;

		TcpListener _listener;
		Thread _acceptThread;
		volatile bool _running;
		volatile TcpClient _client;

		readonly BlockingCollection<string> _outbox = new(new ConcurrentQueue<string>(), 512);
		readonly ConcurrentQueue<Action> _actions = new();
		InputFrame _pending;
		volatile string _worldName = "";

		public bool Connected => _client != null;
		public bool Recording;
		public bool Replaying;

		public BridgeServer(int port) { Port = port; }

		public void Start()
		{
			try
			{
				_listener = new TcpListener(IPAddress.Loopback, Port);
				_listener.Start();
				_running = true;
				_acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "TerrariaAILink-accept" };
				_acceptThread.Start();
				Log($"listening on 127.0.0.1:{Port}");
			}
			catch (Exception e)
			{
				Log("start failed: " + e.Message);
			}
		}

		public void Stop()
		{
			_running = false;
			try { _listener?.Stop(); } catch { }
			var c = _client;
			_client = null;
			try { c?.Close(); } catch { }
		}


		public void Pump()
		{
			while (_actions.TryDequeue(out var action))
			{
				try { action(); }
				catch (Exception e) { Log("action failed: " + e); }
			}
		}

		public void PushState(string json)
		{
			if (_client == null) return;
			if (_outbox.Count > 400) return;
			try { _outbox.Add(json); } catch { }
		}

		public InputFrame NextFrame()
		{
			var local = Main.LocalPlayer;
			if (local == null || !local.active) return null;

			var ctl = local.GetModPlayer<ControlPlayer>();
			if (ctl != null && ctl.ReplayActive) return ctl.ReplayFrame;

			var f = Volatile.Read(ref _pending);
			if (f == null) return null;
			if ((long)Main.GameUpdateCount - f.Tick > 15) return null;
			return f;
		}

		public void ClearInput() => Volatile.Write(ref _pending, null);

		public void ResetWorld()
		{
			Volatile.Write(ref _pending, null);
			Recording = false;
			Replaying = false;
			_worldName = "";
			while (_actions.TryDequeue(out _)) { }
		}


		void AcceptLoop()
		{
			while (_running)
			{
				TcpClient c;
				try { c = _listener.AcceptTcpClient(); }
				catch { break; }
				if (!_running) { c.Close(); break; }

				var old = _client;
				_client = c;
				try { old?.Close(); } catch { }
				while (_outbox.TryTake(out _)) { }

				c.NoDelay = true;
				new Thread(() => ClientLoop(c)) { IsBackground = true, Name = "TerrariaAILink-client" }.Start();
				Log("client connected");
			}
		}

		void ClientLoop(TcpClient c)
		{
			var stream = c.GetStream();
			var reader = new StreamReader(stream, new UTF8Encoding(false));
			var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
			var writerTask = Task.Run(() => WriterLoop(c, writer));

			Send(HelloJson());
			try
			{
				while (_running && ReferenceEquals(_client, c))
				{
					var line = reader.ReadLine();
					if (line == null) break;
					if (line.Length > 4_000_000) continue;
					HandleLine(line);
				}
			}
			catch (Exception e)
			{
				Log("client loop: " + e.Message);
			}

			if (ReferenceEquals(_client, c)) _client = null;
			try { c.Close(); } catch { }
			try { writerTask.Wait(300); } catch { }
			Log("client disconnected");
		}

		async Task WriterLoop(TcpClient c, StreamWriter writer)
		{
			try
			{
				while (_running && ReferenceEquals(_client, c))
				{
					if (!_outbox.TryTake(out var msg, 100)) continue;
					await writer.WriteLineAsync(msg).ConfigureAwait(false);
				}
			}
			catch { }
		}

		void HandleLine(string line)
		{
			try
			{
				using var doc = JsonDocument.Parse(line);
				var root = doc.RootElement;
				if (root.ValueKind != JsonValueKind.Object) return;
				if (!root.TryGetProperty("t", out var tEl)) return;
				switch (tEl.GetString())
				{
					case "in": ApplyInput(root); break;
					case "cmd": HandleCommand(root); break;
					case "ping": Send("{\"t\":\"pong\"}"); break;
					case "hello": Send(HelloJson()); break;
					default: Send(LogJson("unknown message: " + tEl.GetString())); break;
				}
			}
			catch (Exception e)
			{
				Send(LogJson("bad line: " + e.Message));
			}
		}

		void ApplyInput(JsonElement root)
		{
			var f = new InputFrame
			{
				Tick = (long)Main.GameUpdateCount,
				Left = Bool(root, "l"),
				Right = Bool(root, "r"),
				Up = Bool(root, "u"),
				Down = Bool(root, "d"),
				Jump = Bool(root, "j"),
				UseItem = Bool(root, "use"),
				UseTile = Bool(root, "tile"),
				Slot = Int(root, "slot", -1)
			};
			if (root.TryGetProperty("ax", out var ax) && root.TryGetProperty("ay", out var ay))
			{
				f.AimX = (float)ax.GetDouble();
				f.AimY = (float)ay.GetDouble();
			}
			Volatile.Write(ref _pending, f);
		}

		void HandleCommand(JsonElement root)
		{
			string op = root.TryGetProperty("op", out var opEl) ? opEl.GetString() : null;
			switch (op)
			{
				case "say":
				{
					string text = root.TryGetProperty("text", out var tx) ? tx.GetString() : "";
					_actions.Enqueue(() => Chat.PlayerSays(text));
					break;
				}
				case "tiles":
				{
					int x = Int(root, "x", 0), y = Int(root, "y", 0);
					int w = Math.Clamp(Int(root, "w", 64), 1, 240);
					int h = Math.Clamp(Int(root, "h", 48), 1, 160);
					_actions.Enqueue(() => SendTiles(x, y, w, h));
					break;
				}
				case "replay":
				{
					var frames = ParseFrames(root);
					bool loop = Bool(root, "loop");
					_actions.Enqueue(() => Main.LocalPlayer.GetModPlayer<ControlPlayer>().BeginReplay(frames, loop));
					break;
				}
				case "record":
				{
					bool on = Bool(root, "on");
					_actions.Enqueue(() => Main.LocalPlayer.GetModPlayer<ControlPlayer>().SetRecording(on));
					break;
				}
				case "stop":
					_actions.Enqueue(() => Main.LocalPlayer.GetModPlayer<ControlPlayer>().StopAll());
					break;
				case "spawn":
				{
					int type = Int(root, "type", 1);
					int dx = Int(root, "dx", 200);
					int dy = Int(root, "dy", -40);
					_actions.Enqueue(() => SpawnNpc(type, dx, dy));
					break;
				}
				case "clear":
					_actions.Enqueue(ClearHostiles);
					break;
				case "swap":
				{
					int a = Int(root, "a", -1), b = Int(root, "b", -1);
					_actions.Enqueue(() =>
					{
						var p = Main.LocalPlayer;
						if (p == null || a < 0 || b < 0) return;
						if (a >= p.inventory.Length || b >= p.inventory.Length) return;
						var tmp = p.inventory[a];
						p.inventory[a] = p.inventory[b];
						p.inventory[b] = tmp;
					});
					break;
				}
				case "world":
					_actions.Enqueue(() => { _worldName = Main.worldName ?? ""; });
					break;
				default:
					Send(LogJson("unknown cmd: " + op));
					break;
			}
		}

		static List<InputFrame> ParseFrames(JsonElement root)
		{
			var list = new List<InputFrame>();
			if (!root.TryGetProperty("frames", out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
			foreach (var row in arr.EnumerateArray())
			{
				if (row.ValueKind != JsonValueKind.Array) continue;
				var f = new InputFrame();
				int i = 0;
				foreach (var v in row.EnumerateArray())
				{
					if (i <= 6) { if (v.GetInt32() != 0) SetBit(f, i); }
					else if (i == 7) f.Slot = v.GetInt32();
					else if (i == 8) f.AimX = (float)v.GetDouble();
					else if (i == 9) f.AimY = (float)v.GetDouble();
					i++;
				}
				list.Add(f);
			}
			return list;
		}

		static void SetBit(InputFrame f, int i)
		{
			switch (i)
			{
				case 0: f.Left = true; break;
				case 1: f.Right = true; break;
				case 2: f.Up = true; break;
				case 3: f.Down = true; break;
				case 4: f.Jump = true; break;
				case 5: f.UseItem = true; break;
				case 6: f.UseTile = true; break;
			}
		}


		void SendTiles(int x0, int y0, int w, int h)
		{
			x0 = Math.Clamp(x0, 0, Main.maxTilesX - 1);
			y0 = Math.Clamp(y0, 0, Main.maxTilesY - 1);
			w = Math.Min(w, Main.maxTilesX - x0);
			h = Math.Min(h, Main.maxTilesY - y0);
			var data = new byte[w * h * 5];
			int k = 0;
			for (int y = y0; y < y0 + h; y++)
			{
				for (int x = x0; x < x0 + w; x++)
				{
					var tile = Main.tile[x, y];
					ushort type = tile.HasTile ? tile.TileType : (ushort)0;
					byte flags = 0;
					if (tile.HasTile)
					{
						bool solid = Main.tileSolid[type] && !Main.tileSolidTop[type] && !tile.IsActuated;
						bool platform = Main.tileSolidTop[type] && !tile.IsActuated;
						if (solid) flags |= 1;
						if (platform) flags |= 2;
						if (tile.IsActuated) flags |= 4;
						if (tile.IsHalfBlock) flags |= 8;
						flags |= (byte)(((int)tile.Slope & 3) << 4);
					}
					data[k++] = (byte)(type & 0xFF);
					data[k++] = (byte)(type >> 8);
					data[k++] = flags;
					data[k++] = tile.LiquidAmount;
					data[k++] = (byte)tile.LiquidType;
				}
			}
			Send("{\"t\":\"tiles\",\"x\":" + x0 + ",\"y\":" + y0 + ",\"w\":" + w + ",\"h\":" + h
				+ ",\"d\":\"" + Convert.ToBase64String(data) + "\"}");
		}


		public void Send(string json)
		{
			if (_client == null) return;
			try { _outbox.Add(json); } catch { }
		}

		static bool Bool(JsonElement e, string name)
		{
			if (!e.TryGetProperty(name, out var v)) return false;
			return v.ValueKind == JsonValueKind.True || (v.ValueKind == JsonValueKind.Number && v.GetInt32() != 0);
		}

		void SpawnNpc(int type, int dx, int dy)
		{
			var p = Main.LocalPlayer;
			if (p == null || !p.active) return;
			int idx = NPC.NewNPC(Terraria.Entity.GetSource_NaturalSpawn(),
				(int)(p.Center.X + dx), (int)(p.Center.Y + dy), type);
			Send("{\"t\":\"spawned\",\"idx\":" + idx + ",\"type\":" + type + "}");
			Log($"spawn npc type={type} idx={idx}");
		}

		void ClearHostiles()
		{
			int n = 0;
			foreach (var npc in Main.npc)
			{
				if (!npc.active || npc.friendly || npc.townNPC) continue;
				npc.active = false;
				n++;
			}
			Send(LogJson("cleared " + n + " npcs"));
		}

		static int Int(JsonElement e, string name, int fallback)
			=> e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : fallback;

		string HelloJson()
			=> "{\"t\":\"hello\",\"mod\":\"TerrariaAILink\",\"v\":" + ProtocolVersion + ",\"port\":" + Port
			   + ",\"world\":\"" + Esc(_worldName) + "\"}";

		public static string LogJson(string msg)
			=> "{\"t\":\"log\",\"msg\":\"" + Esc(msg) + "\"}";

		public static void Log(string msg)
		{
			try { TerrariaAILinkMod.Instance?.Logger.Info("[TerrariaAILink] " + msg); } catch { }
		}

		public static string Esc(string s)
		{
			if (string.IsNullOrEmpty(s)) return "";
			var sb = new StringBuilder(s.Length + 8);
			foreach (char c in s)
			{
				switch (c)
				{
					case '"': sb.Append("\\\""); break;
					case '\\': sb.Append("\\\\"); break;
					case '\n': sb.Append("\\n"); break;
					case '\r': sb.Append("\\r"); break;
					case '\t': sb.Append("\\t"); break;
					default:
						if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
						else sb.Append(c);
						break;
				}
			}
			return sb.ToString();
		}
	}
}


