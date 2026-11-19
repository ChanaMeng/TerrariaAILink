using System;
using Terraria;
using Terraria.Chat;
using Terraria.ID;
using Terraria.ModLoader;

namespace TerrariaAILink
{
	/// <summary>Sends a chat line as the local player, through the same path the chat box uses.</summary>
	public static class Chat
	{
		public static void PlayerSays(string text)
		{
			if (string.IsNullOrWhiteSpace(text)) return;
			text = text.Replace("\r", " ").Replace("\n", " ").Trim();
			if (text.Length > 400) text = text.Substring(0, 400);

			if (Main.netMode == NetmodeID.SinglePlayer)
			{
				var p = Main.LocalPlayer;
				string name = p != null && p.active ? p.name : "Player";
				Main.NewText(name + ": " + text, (byte)255, (byte)255, (byte)255);
				return;
			}

			try
			{
				ChatHelper.SendChatMessageFromClient(new ChatMessage(text));
			}
			catch (Exception e)
			{
				BridgeServer.Log("say failed: " + e.Message);
			}
		}
	}

	/// <summary>Chat command for local testing: /tailink status | /tailink say &lt;text&gt;</summary>
	public class LinkCommand : ModCommand
	{
		public override CommandType Type => CommandType.Chat;
		public override string Command => "tailink";
		public override string Description => "TerrariaAILink status / test";
		public override string Usage => "/tailink [status|say <text>]";

		public override void Action(CommandCaller caller, string input, string[] args)
		{
			var srv = BridgeSystem.Server;
			if (args.Length == 0 || args[0] == "status")
			{
				caller.Reply($"TerrariaAILink v1 port={srv?.Port} connected={srv?.Connected} recording={srv?.Recording} replay={srv?.Replaying}");
				return;
			}
			if (args[0] == "say")
			{
				string text = string.Join(" ", args, 1, args.Length - 1);
				Chat.PlayerSays(text);
				return;
			}
			caller.Reply("usage: /tailink [status|say <text>]");
		}
	}
}
