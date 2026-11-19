using System;
using System.Collections;
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
		static string _last = "";

		public static void Reset()
		{
			_last = "";
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
						if (!_warned)
						{
							_warned = true;
							srv.Send(BridgeServer.LogJson("chat tap: no _messages on " + monitor.GetType().FullName));
						}
						return;
					}
				}

				var list = _messagesField.GetValue(monitor) as IList;
				if (list == null || list.Count == 0) return;

				string newest = null;
				for (int i = list.Count - 1; i >= 0 && newest == null; i--)
				{
					var item = list[i];
					if (item == null) continue;
					var f = item.GetType().GetField("OriginalText",
						BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
					newest = f != null ? f.GetValue(item) as string : null;
					if (newest == null) newest = item.ToString();
				}

				if (string.IsNullOrEmpty(newest) || newest == _last) return;
				_last = newest;
				srv.Send("{\"t\":\"chat\",\"text\":\"" + BridgeServer.Esc(newest) + "\"}");
			}
			catch (Exception e)
			{
				if (!_warned)
				{
					_warned = true;
					try { srv.Send(BridgeServer.LogJson("chat tap error: " + e.Message)); } catch { }
				}
			}
		}
	}
}
