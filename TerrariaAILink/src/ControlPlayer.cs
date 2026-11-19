using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using Microsoft.Xna.Framework;
using Terraria;
using Terraria.ModLoader;

namespace TerrariaAILink
{
	/// <summary>Applies input frames in ModPlayer.SetControls and runs local record/replay.</summary>
	public class ControlPlayer : ModPlayer
	{
		public bool ReplayActive;
		public InputFrame ReplayFrame;

		readonly List<InputFrame> _replay = new();
		int _replayIndex;
		bool _replayLoop;

		bool _recording;
		readonly List<InputFrame> _recorded = new();
		const int MaxRecordFrames = 60 * 180;

		public bool Recording => _recording;

		public override void SetControls()
		{
			if (Player.whoAmI != Main.myPlayer) return;
			if (Main.gameMenu || Main.drawingPlayerChat || Main.editSign || Main.editChest) return;

			// This client is driven by the bridge, not by the keyboard: keep it
			// "focused" so vanilla does not freeze local control while the user
			// plays in the other window.
			Main.hasFocus = true;

			var srv = BridgeSystem.Server;
			if (srv == null) return;
			var f = srv.NextFrame();
			if (f == null) return;

			Player.controlLeft = f.Left;
			Player.controlRight = f.Right;
			Player.controlUp = f.Up;
			Player.controlDown = f.Down;
			Player.controlJump = f.Jump;
			Player.controlUseItem = f.UseItem;
			Player.controlUseTile = f.UseTile;

			if (f.Slot >= 0 && f.Slot <= 9) Player.selectedItem = f.Slot;

			if (f.HasAim)
			{
				float wx = Player.Center.X + f.AimX * 16f;
				float wy = Player.Center.Y + f.AimY * 16f;
				Main.mouseX = (int)(wx - Main.screenPosition.X);
				Main.mouseY = (int)(wy - Main.screenPosition.Y);
				Main.SmartCursorWanted_Mouse = false;
			}
		}

		public override void PostUpdate()
		{
			if (Player.whoAmI != Main.myPlayer) return;

			if (ReplayActive)
			{
				_replayIndex++;
				if (_replayIndex >= _replay.Count)
				{
					if (_replayLoop && _replay.Count > 0) _replayIndex = 0;
					else EndReplay();
				}
				if (ReplayActive && _replayIndex < _replay.Count) ReplayFrame = _replay[_replayIndex];
			}

			if (_recording && BridgeSystem.Server != null)
			{
				_recorded.Add(CaptureFrame());
				if (_recorded.Count >= MaxRecordFrames)
				{
					SetRecording(false);
				}
			}
		}

		InputFrame CaptureFrame()
		{
			var aimWorld = new Vector2(Main.screenPosition.X + Main.mouseX, Main.screenPosition.Y + Main.mouseY);
			return new InputFrame
			{
				Left = Player.controlLeft,
				Right = Player.controlRight,
				Up = Player.controlUp,
				Down = Player.controlDown,
				Jump = Player.controlJump,
				UseItem = Player.controlUseItem,
				UseTile = Player.controlUseTile,
				Slot = Player.selectedItem,
				AimX = (aimWorld.X - Player.Center.X) / 16f,
				AimY = (aimWorld.Y - Player.Center.Y) / 16f
			};
		}

		public void BeginReplay(List<InputFrame> frames, bool loop)
		{
			_replay.Clear();
			_replay.AddRange(frames);
			_replayIndex = 0;
			_replayLoop = loop;
			ReplayActive = _replay.Count > 0;
			ReplayFrame = ReplayActive ? _replay[0] : null;
			if (BridgeSystem.Server != null) BridgeSystem.Server.Replaying = ReplayActive;
			if (!ReplayActive) BridgeServer.Log("replay: empty frame list");
		}

		void EndReplay()
		{
			ReplayActive = false;
			ReplayFrame = null;
			_replay.Clear();
			_replayIndex = 0;
			if (BridgeSystem.Server != null)
			{
				BridgeSystem.Server.Replaying = false;
				BridgeSystem.Server.Send("{\"t\":\"replay_done\"}");
			}
		}

		public void SetRecording(bool on)
		{
			if (on)
			{
				_recorded.Clear();
				_recording = true;
				if (BridgeSystem.Server != null) BridgeSystem.Server.Recording = true;
				BridgeServer.Log("record: start");
				return;
			}

			if (!_recording) return;
			_recording = false;
			var srv = BridgeSystem.Server;
			if (srv != null)
			{
				srv.Recording = false;
				srv.Send(RecordJson());
			}
			BridgeServer.Log($"record: stop ({_recorded.Count} frames)");
		}

		string RecordJson()
		{
			var sb = new StringBuilder(64 + _recorded.Count * 32);
			sb.Append("{\"t\":\"record\",\"frames\":[");
			for (int i = 0; i < _recorded.Count; i++)
			{
				if (i > 0) sb.Append(',');
				var f = _recorded[i];
				sb.Append('[')
					.Append(f.Left ? '1' : '0').Append(',')
					.Append(f.Right ? '1' : '0').Append(',')
					.Append(f.Up ? '1' : '0').Append(',')
					.Append(f.Down ? '1' : '0').Append(',')
					.Append(f.Jump ? '1' : '0').Append(',')
					.Append(f.UseItem ? '1' : '0').Append(',')
					.Append(f.UseTile ? '1' : '0').Append(',')
					.Append(f.Slot.ToString(CultureInfo.InvariantCulture)).Append(',')
					.Append(f.AimX.ToString("0.##", CultureInfo.InvariantCulture)).Append(',')
					.Append(f.AimY.ToString("0.##", CultureInfo.InvariantCulture))
					.Append(']');
			}
			sb.Append("]}");
			return sb.ToString();
		}

		public void StopAll()
		{
			if (ReplayActive) EndReplay();
			if (_recording) SetRecording(false);
			BridgeSystem.Server?.ClearInput();
		}

		public override void OnEnterWorld()
		{
			StopAll();
		}
	}
}


