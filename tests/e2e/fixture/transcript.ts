// Deterministic transcript fixture for the browser suite (ADR-0005).
//
// The real client renderer is exercised against synthetic session frames over
// the existing WebSocket contract. No Worker fixture endpoint is added: this
// intercepts `/ws` and serves a full `view` frame for each step, which the
// SessionFeed applies exactly like a committed revision.

import type { Page, WebSocketRoute } from "@playwright/test";

export class TranscriptFixture {
  private socket?: WebSocketRoute;
  private entries: unknown[] = [];
  private live?: unknown;
  private historyPages: Array<{ entries: unknown[]; next?: unknown }> = [];

  /** Install the interception before the app opens its session socket. */
  async install(page: Page): Promise<void> {
    await page.routeWebSocket("**/ws**", (ws) => {
      this.socket = ws;
      ws.onMessage((message) => this.onClientMessage(ws, message));
      this.sendView();
    });
  }

  /** Replace the committed transcript, optionally with a live partial. */
  setView(entries: unknown[], live?: unknown): void {
    this.entries = entries;
    this.live = live;
    this.sendView();
  }

  /** Replace only the live partial, keeping the committed transcript. */
  setLive(live?: unknown): void {
    this.live = live;
    this.sendView();
  }

  /** Queue one response for the next history request. */
  pushHistory(entries: unknown[], next?: unknown): void {
    this.historyPages.push({ entries, next });
  }

  private onClientMessage(ws: WebSocketRoute, message: string | Buffer): void {
    let frame: { type?: string; requestId?: string };
    try {
      frame = JSON.parse(String(message)) as { type?: string; requestId?: string };
    } catch {
      return;
    }
    if (frame.type === "history" && typeof frame.requestId === "string") {
      const page = this.historyPages.shift();
      ws.send(
        JSON.stringify({
          type: "history",
          requestId: frame.requestId,
          entries: page?.entries ?? [],
          next: page?.next,
        }),
      );
    }
  }

  private sendView(): void {
    this.socket?.send(
      JSON.stringify({
        type: "view",
        value: {
          conversation: { id: 1 },
          entries: this.entries,
          docs: this.live === undefined ? {} : { "pi.live": this.live },
        },
      }),
    );
  }
}
