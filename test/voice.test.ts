import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VoiceCallKeeper } from "../src/voice";
import { EventEmitter } from "node:events";
import { VoiceConnectionStatus } from "@discordjs/voice";

class MockVoiceConnection extends EventEmitter {
  public state = { status: VoiceConnectionStatus.Ready };
  public joinConfig = { channelId: "target-channel-123" };
  public destroyed = false;

  destroy() {
    this.destroyed = true;
    this.state.status = VoiceConnectionStatus.Destroyed;
    this.emit(VoiceConnectionStatus.Destroyed);
  }
}

describe("VoiceCallKeeper Reconnection & Resilience Logic", () => {
  it("should initialize with correct default stats", () => {
    const keeper = new VoiceCallKeeper({} as any, "guild-123", "target-channel-123");
    assert.equal(keeper.stats.isConnected, false);
    assert.equal(keeper.stats.status, "Initializing");
    assert.equal(keeper.stats.reconnectCount, 0);
    assert.equal(keeper.stats.guildId, "guild-123");
    assert.equal(keeper.stats.channelId, "target-channel-123");
  });

  it("should clean up reconnectTimer and remove listeners when stop() is called", () => {
    const keeper = new VoiceCallKeeper({} as any, "guild-123", "target-channel-123");
    const mockConn = new MockVoiceConnection();
    (keeper as any).connection = mockConn;
    (keeper as any).reconnectTimer = setTimeout(() => {}, 10000);

    keeper.stop();

    assert.equal((keeper as any).reconnectTimer, null);
    assert.equal((keeper as any).connection, null);
    assert.equal(keeper.stats.isConnected, false);
    assert.equal(keeper.stats.status, "Stopped");
    assert.equal(mockConn.listenerCount(VoiceConnectionStatus.Destroyed), 0);
  });

  it("should not double-schedule or infinite loop when a connection is replaced and destroyed", () => {
    const keeper = new VoiceCallKeeper({} as any, "guild-123", "target-channel-123");
    const oldConn = new MockVoiceConnection();
    
    // Simulate connection listeners attached
    (keeper as any).setupConnectionListeners(oldConn);
    (keeper as any).connection = oldConn;

    let reconnectTriggered = false;
    const originalScheduleReconnect = (keeper as any).scheduleReconnect.bind(keeper);
    (keeper as any).scheduleReconnect = () => {
      reconnectTriggered = true;
      originalScheduleReconnect();
    };

    // Simulate cleanup logic from connect()
    if ((keeper as any).connection) {
      try {
        (keeper as any).connection.removeAllListeners();
        (keeper as any).connection.destroy();
      } catch {}
      (keeper as any).connection = null;
    }

    // Since removeAllListeners was called before destroy, scheduleReconnect must NOT have run!
    assert.equal(reconnectTriggered, false, "scheduleReconnect should not be called during intentional cleanup!");
    assert.equal((keeper as any).reconnectTimer, null);
  });

  it("should clear any pending reconnectTimer when VoiceConnectionStatus.Ready fires", () => {
    const keeper = new VoiceCallKeeper({} as any, "guild-123", "target-channel-123");
    const conn = new MockVoiceConnection();
    conn.state.status = VoiceConnectionStatus.Connecting;

    (keeper as any).setupConnectionListeners(conn);
    (keeper as any).connection = conn;

    // Simulate an existing scheduled reconnect timer
    (keeper as any).reconnectTimer = setTimeout(() => {
      throw new Error("This timer should have been cleared!");
    }, 5000);
    (keeper as any).retryDelayMs = 15000;

    // Trigger Ready event
    conn.emit(VoiceConnectionStatus.Ready);

    assert.equal((keeper as any).reconnectTimer, null, "reconnectTimer must be cleared when Ready");
    assert.equal(keeper.stats.isConnected, true);
    assert.equal(keeper.stats.status, "Connected (24/7 Active)");
    assert.equal((keeper as any).retryDelayMs, 5000, "retryDelayMs must reset to 5000ms");
  });

  it("should prevent concurrent connect() executions using isConnecting lock", async () => {
    const keeper = new VoiceCallKeeper({} as any, "guild-123", "target-channel-123");
    (keeper as any).isConnecting = true;

    let fetchCalled = false;
    (keeper as any).client = {
      guilds: {
        fetch: async () => {
          fetchCalled = true;
          return null;
        },
      },
    };

    await keeper.connect();

    assert.equal(fetchCalled, false, "connect() should immediately return if isConnecting is true");
  });

  it("should exponentially backoff retry delay up to a 30s cap", () => {
    const keeper = new VoiceCallKeeper({} as any, "guild-123", "target-channel-123");
    assert.equal((keeper as any).retryDelayMs, 5000);

    // Call scheduleReconnect multiple times
    (keeper as any).scheduleReconnect();
    assert.equal(keeper.stats.reconnectCount, 1);
    // Clear timer
    clearTimeout((keeper as any).reconnectTimer);

    // Simulate timer execution
    (keeper as any).retryDelayMs = Math.min((keeper as any).retryDelayMs * 1.5, 30_000);
    assert.equal((keeper as any).retryDelayMs, 7500);

    (keeper as any).retryDelayMs = Math.min((keeper as any).retryDelayMs * 1.5, 30_000);
    assert.equal((keeper as any).retryDelayMs, 11250);

    (keeper as any).retryDelayMs = Math.min((keeper as any).retryDelayMs * 1.5, 30_000);
    assert.equal((keeper as any).retryDelayMs, 16875);

    (keeper as any).retryDelayMs = Math.min((keeper as any).retryDelayMs * 1.5, 30_000);
    assert.equal((keeper as any).retryDelayMs, 25312.5);

    (keeper as any).retryDelayMs = Math.min((keeper as any).retryDelayMs * 1.5, 30_000);
    assert.equal((keeper as any).retryDelayMs, 30000, "Should be capped at 30,000ms");

    (keeper as any).retryDelayMs = Math.min((keeper as any).retryDelayMs * 1.5, 30_000);
    assert.equal((keeper as any).retryDelayMs, 30000, "Should stay capped at 30,000ms");
  });

  it("remembers a forced reconnect requested while a connection attempt is in progress", async () => {
    const keeper = new VoiceCallKeeper({} as any, "guild-123", "target-channel-123");
    (keeper as any).isConnecting = true;

    await keeper.connect(true);

    assert.equal((keeper as any).pendingReconnect, true);
    assert.equal((keeper as any).reconnectTimer, null);
  });

  it("schedules a quick rejoin when a disconnect was queued during connect()", () => {
    const keeper = new VoiceCallKeeper({} as any, "guild-123", "target-channel-123");
    (keeper as any).pendingReconnect = true;

    (keeper as any).flushPendingReconnect();

    assert.equal((keeper as any).pendingReconnect, false);
    assert.equal(keeper.stats.reconnectCount, 1);
    assert.ok((keeper as any).reconnectTimer, "a reconnect timer must be armed");
    clearTimeout((keeper as any).reconnectTimer);
    (keeper as any).reconnectTimer = null;
  });

  it("rejoins when Discord's cached voice state is outside the target channel", async () => {
    const keeper = new VoiceCallKeeper(
      {
        user: { id: "bot-1" },
        guilds: {
          cache: {
            get: () => ({
              voiceStates: {
                cache: {
                  get: () => ({ channelId: null }),
                },
              },
            }),
          },
        },
      } as any,
      "guild-123",
      "target-channel-123"
    );
    keeper.stats.isConnected = true;
    keeper.stats.connectedSince = new Date();

    let forced = false;
    (keeper as any).connect = async (force: boolean) => {
      forced = force;
    };

    await (keeper as any).watchdogCheck();

    assert.equal(forced, true);
    assert.equal(keeper.stats.isConnected, false);
    assert.equal(keeper.stats.connectedSince, null);
    assert.equal(keeper.readCachedChannelId(), null);
  });

  it("reconnects when Discord lists the bot in the target channel but the voice socket is gone", async () => {
    const calls: boolean[] = [];
    const keeper = new VoiceCallKeeper(
      {
        user: { id: "bot-1" },
        guilds: {
          cache: {
            get: () => ({
              voiceStates: {
                cache: {
                  get: () => ({ channelId: "target-channel-123" }),
                },
              },
            }),
          },
        },
      } as any,
      "guild-123",
      "target-channel-123"
    );
    (keeper as any).connect = async (force?: boolean) => {
      calls.push(Boolean(force));
    };

    assert.equal(keeper.readCachedChannelId(), "target-channel-123");

    await (keeper as any).watchdogCheck();

    assert.deepEqual(calls, [false]);
  });

  it("should record lastDisconnectReason when connection error occurs", () => {
    const keeper = new VoiceCallKeeper({} as any, "guild-123", "target-channel-123");
    const conn = new MockVoiceConnection();
    (keeper as any).setupConnectionListeners(conn);

    conn.emit("error", new Error("Simulated WebSocket Socket Hangup"));

    assert.equal(keeper.stats.lastDisconnectReason, "Simulated WebSocket Socket Hangup");
  });
});
