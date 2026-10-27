import { Client, GatewayIntentBits, ActivityType, Events } from "discord.js";
import { getVoiceConnection, VoiceConnectionStatus } from "@discordjs/voice";
import { loadConfig } from "./config";
import { VoiceCallKeeper } from "./voice";
import { startHttpServer } from "./server";

async function main() {
  console.log("\n=======================================================");
  console.log("  🚀 Starting Discord Call Keeper (24/7 Voice Sustainer)");
  console.log("=======================================================\n");

  const config = loadConfig();

  // Create Discord client with required intents
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  const voiceKeeper = new VoiceCallKeeper(client, config.guildId, config.channelId);

  // Start HTTP server immediately so Render health checks and UptimeRobot pass during boot
  const server = startHttpServer(config.port, client, voiceKeeper);

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[Bot] Logged in as ${readyClient.user.tag}!`);

    // Set custom bot presence
    readyClient.user.setPresence({
      activities: [
        {
          name: "Sustaining Call 24/7 🟢",
          type: ActivityType.Custom,
        },
      ],
      status: "online",
    });

    // Start voice keeper connection
    await voiceKeeper.start();
  });

  client.on(Events.Error, (err) => {
    console.error("[Bot Error]", err);
  });

  // Fast sub-second recovery if the bot is kicked or moved to another channel (e.g. AFK)
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (newState.id !== client.user?.id) return;

    if (!newState.channelId) {
      // A leave only counts when Discord reports the bot was in a channel, or the
      // keeper already marked the socket as connected. The empty state sent at login
      // has neither, including while the first join is still in progress.
      const confirmedLeave = Boolean(oldState.channelId) || voiceKeeper.stats.isConnected;
      if (!confirmedLeave) return;
      console.warn(
        "[Voice State] Bot is not in a voice channel. Rejoining the target channel..."
      );
      voiceKeeper.markNotInChannel("Discord removed the bot from the voice channel");
      void voiceKeeper.connect(true);
      return;
    }

    if (newState.channelId !== config.channelId) {
      console.warn(
        `[Voice State] Bot was moved to channel ${newState.channelId} (expected ${config.channelId}). Re-joining target channel immediately...`
      );
      voiceKeeper.connect(true);
    }
  });

  // Gateway shard lifecycle monitoring
  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(`[Shard ${shardId}] Disconnected from Discord Gateway (code: ${event.code})`);
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    console.log(`[Shard ${shardId}] Reconnecting to Discord Gateway...`);
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    console.log(
      `[Shard ${shardId}] Resumed Gateway session (replayed ${replayedEvents} events). Checking voice connection...`
    );
    // Crucial: A Gateway resume does NOT drop the voice connection!
    // Only reconnect if the voice socket was actually lost or disrupted.
    const existingConn = getVoiceConnection(config.guildId);
    if (!existingConn || existingConn.state.status !== VoiceConnectionStatus.Ready) {
      console.warn(
        `[Shard ${shardId}] Voice connection was affected by gateway reconnect. Re-establishing...`
      );
      voiceKeeper.connect(true);
    } else {
      console.log(
        `[Shard ${shardId}] Voice connection remained completely stable during gateway resume. No interruption needed.`
      );
    }
  });

  client.on(Events.ShardError, (error, shardId) => {
    console.error(`[Shard ${shardId}] Gateway socket error:`, error);
  });

  // Anti-crash handlers to ensure process never exits unexpectedly during 100+ hour calls
  process.on("unhandledRejection", (reason) => {
    console.error("[Anti-Crash] Unhandled Promise Rejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    console.error("[Anti-Crash] Uncaught Exception thrown:", error);
  });

  // Graceful shutdown handling
  const shutdown = () => {
    console.log("\n[App] Shutting down gracefully...");
    voiceKeeper.stop();
    server.close(() => {
      console.log("[App] HTTP server closed.");
    });
    client.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Log in to Discord
  console.log("[Bot] Logging in to Discord Gateway...");
  try {
    await client.login(config.token);
  } catch (error: any) {
    console.error("\n❌ FAILED TO LOG IN TO DISCORD:");
    console.error(error?.message || error);
    console.error("\nPlease ensure your DISCORD_TOKEN is valid and reset it if necessary.\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled fatal error:", err);
  process.exit(1);
});
