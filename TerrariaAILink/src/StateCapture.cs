using System;
using System.Globalization;
using System.Text;
using Terraria;
using Terraria.ModLoader;

namespace TerrariaAILink
{
	/// <summary>Builds the compact JSON state line. Must run on the main thread.</summary>
	public static class StateCapture
	{
		public static string Capture(Player p, BridgeServer srv)
		{
			long tick = (long)Main.GameUpdateCount;
			var sb = new StringBuilder(8192);
			sb.Append("{\"t\":\"state\",\"tick\":").Append(tick);
			sb.Append(",\"tm\":").Append(((int)Main.time).ToString(CultureInfo.InvariantCulture));
			sb.Append(",\"day\":").Append(Main.dayTime ? 1 : 0);
			sb.Append(",\"bm\":").Append(Main.bloodMoon ? 1 : 0);
			sb.Append(",\"ec\":").Append(Main.eclipse ? 1 : 0);
			sb.Append(",\"hm\":").Append(Main.hardMode ? 1 : 0);
			sb.Append(",\"iv\":").Append(Main.invasionType);
			sb.Append(",\"mx\":").Append(Main.maxTilesX).Append(",\"my\":").Append(Main.maxTilesY);
			sb.Append(",\"rec\":").Append(srv.Recording ? 1 : 0);
			sb.Append(",\"rep\":").Append(srv.Replaying ? 1 : 0);

			AppendPlayer(sb, p, tick);
			AppendBuffs(sb, p);
			AppendNpcs(sb, p);
			AppendProjectiles(sb, p);
			AppendItems(sb, p);
			AppendHotbar(sb, p);
			if (tick % 30 == 0) AppendInventory(sb, p);

			sb.Append('}');
			return sb.ToString();
		}

		static void AppendPlayer(StringBuilder sb, Player p, long tick)
		{
			sb.Append(",\"p\":{");
			sb.Append("\"nm\":\"").Append(BridgeServer.Esc(p.name)).Append('"');
			sb.Append(",\"x\":"); F(sb, p.Center.X);
			sb.Append(",\"y\":"); F(sb, p.Center.Y);
			sb.Append(",\"vx\":"); F(sb, p.velocity.X);
			sb.Append(",\"vy\":"); F(sb, p.velocity.Y);
			sb.Append(",\"w\":").Append(p.width).Append(",\"h\":").Append(p.height);
			sb.Append(",\"hp\":").Append(p.statLife).Append(",\"mhp\":").Append(p.statLifeMax2);
			sb.Append(",\"mp\":").Append(p.statMana).Append(",\"mmp\":").Append(p.statManaMax2);
			sb.Append(",\"air\":").Append(p.breath).Append(",\"amax\":").Append(p.breathMax);
			sb.Append(",\"grd\":").Append(p.velocity.Y == 0f ? 1 : 0);
			sb.Append(",\"dir\":").Append(p.direction);
			sb.Append(",\"sl\":").Append(p.selectedItem);
			sb.Append(",\"dead\":").Append(p.dead ? 1 : 0);
			sb.Append(",\"resp\":").Append(p.respawnTimer);
			sb.Append(",\"wing\":"); F(sb, p.wingTime);
			sb.Append(",\"dash\":").Append(p.dashType);
			sb.Append(",\"mnt\":").Append(p.mount.Active ? p.mount.Type : -1);
			sb.Append(",\"use\":").Append(p.itemAnimation > 0 ? 1 : 0);
			sb.Append(",\"it\":"); AppendItem(sb, p.HeldItem);
			sb.Append('}');
		}

		static void AppendItem(StringBuilder sb, Item it)
		{
			sb.Append('{');
			sb.Append("\"ty\":").Append(it.type);
			sb.Append(",\"nm\":\"").Append(BridgeServer.Esc(it.Name)).Append('"');
			sb.Append(",\"ut\":").Append(it.useTime);
			sb.Append(",\"ua\":").Append(it.useAnimation);
			sb.Append(",\"ar\":").Append(it.autoReuse ? 1 : 0);
			sb.Append(",\"dm\":").Append(it.damage);
			sb.Append(",\"ss\":"); F(sb, it.shootSpeed);
			sb.Append(",\"sh\":").Append(it.shoot);
			sb.Append(",\"me\":").Append(it.CountsAsClass(DamageClass.Melee) ? 1 : 0);
			sb.Append(",\"rg\":").Append(it.CountsAsClass(DamageClass.Ranged) ? 1 : 0);
			sb.Append(",\"mg\":").Append(it.CountsAsClass(DamageClass.Magic) ? 1 : 0);
			sb.Append(",\"sm\":").Append(it.CountsAsClass(DamageClass.Summon) ? 1 : 0);
			sb.Append(",\"pk\":").Append(it.pick);
			sb.Append(",\"ax\":").Append(it.axe);
			sb.Append(",\"hm\":").Append(it.hammer);
			sb.Append(",\"am\":").Append(it.useAmmo);
			sb.Append(",\"mc\":").Append(it.mana);
			sb.Append(",\"ch\":").Append(it.channel ? 1 : 0);
			sb.Append(",\"us\":").Append(it.useStyle);
			sb.Append('}');
		}

		static void AppendBuffs(StringBuilder sb, Player p)
		{
			sb.Append(",\"bf\":[");
			bool first = true;
			for (int i = 0; i < p.buffType.Length; i++)
			{
				int type = p.buffType[i];
				if (type <= 0 || p.buffTime[i] <= 0) continue;
				if (!first) sb.Append(',');
				first = false;
				sb.Append('[').Append(type).Append(',').Append(p.buffTime[i] / 60).Append(']');
			}
			sb.Append(']');
		}

		static void AppendNpcs(StringBuilder sb, Player p)
		{
			sb.Append(",\"n\":[");
			bool first = true;
			float px = p.Center.X, py = p.Center.Y;
			for (int i = 0; i < Main.maxNPCs; i++)
			{
				var n = Main.npc[i];
				if (!n.active) continue;
				float dx = n.Center.X - px, dy = n.Center.Y - py;
				bool near = dx * dx + dy * dy <= 2400f * 2400f;
				if (!near && !n.boss && n.realLife < 0) continue;
				if (!first) sb.Append(',');
				first = false;
				sb.Append('{');
				sb.Append("\"i\":").Append(i);
				sb.Append(",\"ty\":").Append(n.type);
				sb.Append(",\"x\":"); F(sb, n.Center.X);
				sb.Append(",\"y\":"); F(sb, n.Center.Y);
				sb.Append(",\"vx\":"); F(sb, n.velocity.X);
				sb.Append(",\"vy\":"); F(sb, n.velocity.Y);
				sb.Append(",\"w\":").Append(n.width).Append(",\"h\":").Append(n.height);
				sb.Append(",\"lf\":").Append(n.life).Append(",\"lm\":").Append(n.lifeMax);
				sb.Append(",\"bo\":").Append(n.boss ? 1 : 0);
				sb.Append(",\"fr\":").Append(n.friendly || n.townNPC ? 1 : 0);
				sb.Append(",\"dm\":").Append(n.damage);
				sb.Append(",\"ai\":").Append(n.aiStyle);
				sb.Append(",\"rl\":").Append(n.realLife);
				sb.Append(",\"a\":[");
				F(sb, n.ai[0]); sb.Append(',');
				F(sb, n.ai[1]); sb.Append(',');
				F(sb, n.ai[2]); sb.Append(',');
				F(sb, n.ai[3]);
				sb.Append(']');
				if (n.boss || n.realLife >= 0)
					sb.Append(",\"nm\":\"").Append(BridgeServer.Esc(n.FullName)).Append('"');
				sb.Append('}');
			}
			sb.Append(']');
		}

		static void AppendProjectiles(StringBuilder sb, Player p)
		{
			sb.Append(",\"pr\":[");
			bool first = true;
			float px = p.Center.X, py = p.Center.Y;
			for (int i = 0; i < Main.maxProjectiles; i++)
			{
				var pr = Main.projectile[i];
				if (!pr.active || pr.damage <= 0) continue;
				bool mine = pr.owner == Main.myPlayer;
				if (!pr.hostile && !mine) continue;
				float dx = pr.Center.X - px, dy = pr.Center.Y - py;
				if (dx * dx + dy * dy > 2600f * 2600f) continue;
				if (!first) sb.Append(',');
				first = false;
				sb.Append('{');
				sb.Append("\"i\":").Append(i);
				sb.Append(",\"ty\":").Append(pr.type);
				sb.Append(",\"x\":"); F(sb, pr.Center.X);
				sb.Append(",\"y\":"); F(sb, pr.Center.Y);
				sb.Append(",\"vx\":"); F(sb, pr.velocity.X);
				sb.Append(",\"vy\":"); F(sb, pr.velocity.Y);
				sb.Append(",\"w\":").Append(pr.width).Append(",\"h\":").Append(pr.height);
				sb.Append(",\"dm\":").Append(pr.damage);
				sb.Append(",\"ho\":").Append(pr.hostile ? 1 : 0);
				sb.Append(",\"ow\":").Append(pr.owner);
				sb.Append(",\"eu\":").Append(pr.extraUpdates);
				sb.Append(",\"ai\":").Append(pr.aiStyle);
				sb.Append('}');
			}
			sb.Append(']');
		}

		static void AppendItems(StringBuilder sb, Player p)
		{
			sb.Append(",\"dr\":[");
			bool first = true;
			float px = p.Center.X, py = p.Center.Y;
			int count = 0;
			for (int i = 0; i < Main.maxItems && count < 60; i++)
			{
				var it = Main.item[i];
				if (!it.active) continue;
				float dx = it.Center.X - px, dy = it.Center.Y - py;
				if (dx * dx + dy * dy > 1200f * 1200f) continue;
				if (!first) sb.Append(',');
				first = false;
				count++;
				sb.Append('[').Append(i).Append(',').Append(it.type).Append(',');
				F(sb, it.Center.X); sb.Append(',');
				F(sb, it.Center.Y); sb.Append(',').Append(it.stack).Append(']');
			}
			sb.Append(']');
		}

		static void AppendHotbar(StringBuilder sb, Player p)
		{
			sb.Append(",\"hb\":[");
			for (int i = 0; i < 10; i++)
			{
				if (i > 0) sb.Append(',');
				var it = p.inventory[i];
				sb.Append(it == null ? 0 : it.type);
			}
			sb.Append(']');
		}

		static void AppendInventory(StringBuilder sb, Player p)
		{
			sb.Append(",\"in\":[");
			for (int i = 0; i < p.inventory.Length; i++)
			{
				if (i > 0) sb.Append(',');
				var it = p.inventory[i];
				sb.Append(it == null ? 0 : it.type);
			}
			sb.Append(']');
		}

		static void F(StringBuilder sb, float v)
			=> sb.Append(v.ToString("0.##", CultureInfo.InvariantCulture));
	}
}


