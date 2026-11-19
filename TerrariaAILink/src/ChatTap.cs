using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using Terraria;

namespace TerrariaAILink
{
	/// <summary>Watches the game's chat monitor and forwards new lines to the bridge.</summary>
	public static class ChatTap
	{
		static FieldInfo _monitorField;
		static FieldInfo _messagesField;
		static bool _warned;
		static bool _primed;
		static readonly Dictionary<string, long> Seen = new();
		const long SeenTtlTicks = 60 * 60;

		public static void Reset()
		{
			_primed = false;
			Seen.Clear();
		}

		public static void Tick(BridgeServer srv)
		{
			try
			{
				if (_monitorField == null)
				{
					_monitorField = typeof(Main).GetField("chatMonitor",
						BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
					if (_monitorField == null) return;
				}

				object monitor = _monitorField.GetValue(null);
				if (monitor == null) return;

				if (_messagesField == null)
				{
					_messagesField = monitor.GetType().GetField("_messages",
						BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
					if (_messagesField == null)
					{
						Warn(srv, "chat tap: no _messages on " + monitor.GetType().FullName);
						return;
					}
				}

				var list = _messagesField.GetValue(monitor) as IList;
				if (list == null || list.Count == 0) return;

				long now = (long)Main.GameUpdateCount;
				Purge(now);

				bool first = !_primed;
				_primed = true;

				var fresh = new List<string>();
				for (int i = 0; i < list.Count; i++)
				{
					string text = TextOf(list[i]);
					if (string.IsNullOrEmpty(text)) continue;
					if (Seen.ContainsKey(text)) continue;
					Seen[text] = now;
					if (!first) fresh.Add(text);
				}

				foreach (var line in fresh)
					srv.Send("{\"t\":\"chat\",\"text\":\"" + BridgeServer.Esc(line) + "\"}");
			}
			catch (Exception e)
			{
				Warn(srv, "chat tap error: " + e.Message);
			}
		}

		static string TextOf(object item)
		{
			if (item == null) return null;
			var f = item.GetType().GetField("OriginalText",
				BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
			return f != null ? f.GetValue(item) as string : null;
		}

		static void Purge(long now)
		{
			if (Seen.Count < 400) return;
			var stale = new List<string>();
			foreach (var kv in Seen)
				if (now - kv.Value > SeenTtlTicks) stale.Add(kv.Key);
			foreach (var k in stale) Seen.Remove(k);
		}

		static void Warn(BridgeServer srv, string msg)
		{
			if (_warned) return;
			_warned = true;
			try { srv.Send(BridgeServer.LogJson(msg)); } catch { }
		}
	}
}
