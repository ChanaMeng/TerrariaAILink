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

		public override void PostUpdateEverything()
		{
			var s = Server;
			if (s == null) return;


			if (!s.Connected) return;

			if (Main.gameMenu)
			{
				s.PushState("{\"t\":\"state\",\"menu\":true,\"tick\":" + Main.GameUpdateCount + "}");
				return;
			}

			var p = Main.LocalPlayer;
			if (p == null || !p.active) return;

			s.PushState(StateCapture.Capture(p, s));
		}

		public override void OnWorldUnload()
		{
			Server?.ResetWorld();
		}
	}
}


