import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} from "@discordjs/voice";
import { Client, VoiceBasedChannel, ChannelType } from "discord.js";

export interface VoiceManagerStats {
  isConnected: boolean;
  status: string;
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  connectedSince: Date | null;
  reconnectCount: number;
  lastDisconnectReason: string | null;
}

export class VoiceCallKeeper {
  private client: Client;
  private guildId: string;
  private channelId: string;
  private connection: VoiceConnection | null = null;
  private isShuttingDown = false;
  private isConnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private pendingReconnect = false;
  private retryDelayMs = 5000;

  // Stats
  public stats: VoiceManagerStats;

  public get isConnectingState(): boolean {
    return this.isConnecting;
  }

  constructor(client: Client, guildId: string, channelId: string) {
    this.client = client;
    this.guildId = guildId;
    this.channelId = channelId;

    this.stats = {
      isConnected: false,
      status: "Initializing",
      guildId,
      guildName: "Unknown Guild",
      channelId,
      channelName: "Unknown Channel",
      connectedSince: null,
      reconnectCount: 0,
      lastDisconnectReason: null,
    };
  }

  public async start(): Promise<void> {
    await this.connect();

    // Check Discord's own member list, not only the local voice socket.
    this.watchdogTimer = setInterval(() => {
      void this.watchdogCheck();
    }, 10_000);
  }

  public markNotInChannel(reason: string): void {
    this.stats.isConnected = false;
    this.stats.status = "Not in voice channel";
    this.stats.lastDisconnectReason = reason;
    this.stats.connectedSince = null;
  }

  /**
   * Discord's cached voice state for this bot.
   * `undefined` means the cache has no state yet, so the caller must not treat it as a disconnect.
   */
  public readCachedChannelId(): string | null | undefined {
    const userId = this.client.user?.id;
    if (!userId) return undefined;
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) return undefined;
    const state = guild.voiceStates.cache.get(userId);
    if (!state) return undefined;
    return state.channelId ?? null;
  }

  public async connect(force = false): Promise<void> {
    if (this.isShuttingDown) return;
    if (this.isConnecting) {
      if (force) this.pendingReconnect = true;
      return;
    }

    // Check if we already have a healthy connection in the target channel
    const existingConn = getVoiceConnection(this.guildId);
    if (
      !force &&
      existingConn &&
      existingConn.state.status === VoiceConnectionStatus.Ready &&
      existingConn.joinConfig.channelId === this.channelId
    ) {
      this.stats.isConnected = true;
      this.stats.status = "Connected (24/7 Active)";
      return;
    }

    if (
      !force &&
      existingConn &&
      (existingConn.state.status === VoiceConnectionStatus.Signalling ||
        existingConn.state.status === VoiceConnectionStatus.Connecting)
    ) {
      return;
    }

    this.isConnecting = true;

    try {
      const guild = await this.client.guilds.fetch(this.guildId).catch(() => null);
      if (!guild) {
        throw new Error(
          `Guild with ID ${this.guildId} could not be found. Ensure the bot has been invited to this server!`
        );
      }
      this.stats.guildName = guild.name;

      const channel = await guild.channels.fetch(this.channelId).catch(() => null);
      if (!channel) {
        throw new Error(
          `Channel with ID ${this.channelId} could not be found in guild "${guild.name}". Ensure the channel ID is correct!`
        );
      }

      if (
        channel.type !== ChannelType.GuildVoice &&
        channel.type !== ChannelType.GuildStageVoice
      ) {
        throw new Error(
          `Channel "${channel.name}" (${this.channelId}) is not a Voice or Stage channel.`
        );
      }
      this.stats.channelName = channel.name;

      // Clean up previous connection if any; remove listeners so destroying doesn't trigger rogue reconnect timers
      if (this.connection) {
        try {
          this.connection.removeAllListeners();
          this.connection.destroy();
        } catch {}
        this.connection = null;
      }

      console.log(
        `[Voice] Connecting to voice channel "${channel.name}" in guild "${guild.name}"...`
      );
      this.stats.status = "Connecting";

      // Join channel with selfDeaf & selfMute to preserve bandwidth and privacy
      const connection = joinVoiceChannel({
        channelId: this.channelId,
        guildId: this.guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: true,
      });

      this.connection = connection;
      this.setupConnectionListeners(connection);

      // Wait for the connection to be ready (up to 30 seconds)
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      console.log(`[Voice] Successfully connected and holding call in "${channel.name}"!`);
      this.stats.isConnected = true;
      this.stats.status = "Connected (24/7 Active)";
      if (!this.stats.connectedSince) {
        this.stats.connectedSince = new Date();
      }

      // Clear any pending reconnect timers once connected
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.retryDelayMs = 5000; // Reset retry delay on success
    } catch (error: any) {
      console.error(`[Voice] Connection error:`, error?.message || error);
      this.stats.isConnected = false;
      this.stats.status = "Connection Failed";
      this.stats.lastDisconnectReason = error?.message || String(error);
      this.stats.connectedSince = null;
      this.scheduleReconnect();
      this.pendingReconnect = false;
    } finally {
      this.isConnecting = false;
      this.flushPendingReconnect();
    }
  }

  private flushPendingReconnect(): void {
    if (!this.pendingReconnect || this.isShuttingDown) return;
    this.pendingReconnect = false;
    console.warn(
      "[Voice] A disconnect arrived while a connection attempt was in progress. Rejoining..."
    );
    this.scheduleReconnect(1_000);
  }

  private setupConnectionListeners(connection: VoiceConnection): void {
    connection.on("stateChange", (oldState, newState) => {
      console.log(`[Voice State] ${oldState.status} -> ${newState.status}`);
    });

    connection.on("debug", (message) => {
      console.log(`[Voice Debug] ${message}`);
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log("[Voice] Voice connection is READY.");
      this.stats.isConnected = true;
      this.stats.status = "Connected (24/7 Active)";
      if (!this.stats.connectedSince) {
        this.stats.connectedSince = new Date();
      }
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.retryDelayMs = 5000;
    });

    connection.on(VoiceConnectionStatus.Signalling, () => {
      this.stats.status = "Signalling";
    });

    connection.on(VoiceConnectionStatus.Connecting, () => {
      this.stats.status = "Connecting";
    });

    connection.on(
      VoiceConnectionStatus.Disconnected,
      async (oldState, newState) => {
        console.warn("[Voice] Connection was disconnected.");
        this.stats.isConnected = false;
        this.stats.status = "Disconnected";

        try {
          // If disconnected, try to see if it's a server migration/reconnect first
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          console.log("[Voice] Voice server re-established connection successfully.");
        } catch {
          // Truly disconnected: destroying will fire VoiceConnectionStatus.Destroyed which triggers scheduleReconnect()
          console.warn("[Voice] Connection lost permanently. Destroying and reconnecting...");
          this.stats.lastDisconnectReason = "Network / Voice Server disconnect";
          connection.destroy();
        }
      }
    );

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.warn("[Voice] Voice connection was destroyed.");
      this.stats.isConnected = false;
      this.stats.status = "Destroyed";
      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    });

    connection.on("error", (error) => {
      console.error("[Voice] Internal voice connection error:", error);
      this.stats.lastDisconnectReason = error.message;
    });
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.isShuttingDown) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const delay = delayMs ?? this.retryDelayMs;
    const growBackoff = delayMs === undefined;
    this.stats.reconnectCount++;
    console.log(
      `[Voice] Scheduling reconnect attempt #${this.stats.reconnectCount} in ${delay / 1000}s...`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (growBackoff) {
        // Exponential backoff capped at 30 seconds
        this.retryDelayMs = Math.min(this.retryDelayMs * 1.5, 30_000);
      }
      void this.connect(true);
    }, delay);
  }

  private async watchdogCheck(): Promise<void> {
    if (this.isShuttingDown || this.isConnecting) return;

    const actualChannelId = this.readCachedChannelId();
    if (actualChannelId !== undefined && actualChannelId !== this.channelId) {
      if (!this.reconnectTimer) {
        console.warn(
          `[Voice Watchdog] Discord lists the bot in ${
            actualChannelId ?? "no channel"
          }, expected ${this.channelId}. Re-joining target channel...`
        );
        this.markNotInChannel("Discord voice state does not match the target channel");
        await this.connect(true);
      }
      return;
    }

    const existingConn = getVoiceConnection(this.guildId);
    if (!existingConn) {
      if (!this.reconnectTimer) {
        console.warn("[Voice Watchdog] Voice connection is missing. Re-triggering connect...");
        this.connect();
      }
      return;
    }

    // If it's already attempting to signal or connect (e.g. Discord server migration), allow it to settle
    if (
      existingConn.state.status === VoiceConnectionStatus.Signalling ||
      existingConn.state.status === VoiceConnectionStatus.Connecting
    ) {
      console.log(
        `[Voice Watchdog] Connection is in transitional state (${existingConn.state.status}), allowing it to settle...`
      );
      return;
    }

    if (existingConn.state.status !== VoiceConnectionStatus.Ready) {
      if (!this.reconnectTimer) {
        console.warn(
          `[Voice Watchdog] Voice connection status is "${existingConn.state.status}". Re-triggering connect...`
        );
        this.connect();
      }
      return;
    }

    // Ensure bot is in the designated channel (detect if moved to AFK or another channel)
    if (existingConn.joinConfig.channelId !== this.channelId) {
      console.warn(
        `[Voice Watchdog] Bot is in channel ${existingConn.joinConfig.channelId}, expected ${this.channelId}. Re-joining target channel...`
      );
      this.connect();
    }
  }

  public stop(): void {
    this.isShuttingDown = true;
    this.pendingReconnect = false;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connection) {
      try {
        this.connection.removeAllListeners();
        this.connection.destroy();
      } catch {}
      this.connection = null;
    }
    this.stats.isConnected = false;
    this.stats.status = "Stopped";
    console.log("[Voice] Call keeper voice manager stopped.");
  }
}
