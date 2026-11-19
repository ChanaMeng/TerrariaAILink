using Terraria.ModLoader;

namespace TerrariaAILink
{
	/// <summary>TerrariaAILink: a local TCP bridge that lets an external program read state and drive the local player.</summary>
	public class TerrariaAILinkMod : Mod
	{
		public static TerrariaAILinkMod Instance { get; private set; }

		public override void Load()
		{
			Instance = this;
		}

		public override void Unload()
		{
			Instance = null;
		}
	}
}


