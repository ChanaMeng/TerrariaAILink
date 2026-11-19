using System;
using System.Collections.Concurrent;
using Terraria;
using Terraria.ModLoader;

namespace TerrariaAILink
{
	/// <summary>Owns the bridge server and pushes one state line per tick.</summary>
	public class BridgeSystem : ModSystem
	{
		public static BridgeServer Server { get; private set; }

		public override void Load()
		{
			Server = new BridgeServer(BridgeServer.DefaultPort);
			Server.Start();
		}

		public override void Unload()
		{
			Server?.Stop();
			Server = null;
		}

		public override void PreUpdatePlayers()
		{
			// Run before the vanilla update decides whether the local player is
			// allowed to act: this client is bridge-driven and must not depend on
			// the window actually owning keyboard focus.
			if (!Main.gameMenu) Main.hasFocus = true;
		}

		public override void PostUpdateEverything()
		{
			var s = Server;
			if (s == null) return;

			s.Pump();

			if (!s.Connected) return;

			if (Main.gameMenu)
			{
				s.PushState("{\"t\":\"state\",\"menu\":true,\"tick\":" + Main.GameUpdateCount + "}");
				return;
			}

			var p = Main.LocalPlayer;
			if (p == null || !p.active) return;

			Main.hasFocus = true;
			s.PushState(StateCapture.Capture(p, s));
			ChatTap.Tick(s);
		}

		public override void OnWorldUnload()
		{
			ChatTap.Reset();
			Server?.ResetWorld();
		}
	}
}


