import { LogEntry, LogLevel } from "./types";

type LogListener = (entries: readonly LogEntry[], latest: LogEntry | null) => void;

export class LogBus {
  private entries: LogEntry[] = [];
  private listeners = new Set<LogListener>();
  private nextId = 1;

  constructor(private readonly limit = 500) {}

  append(level: LogLevel, source: string, message: string, durationMs?: number): LogEntry {
    const entry: LogEntry = {
      id: this.nextId++,
      timestamp: Date.now(),
      level,
      source,
      message: message.trim(),
      durationMs,
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.emit(entry);
    return entry;
  }

  clear(): void {
    this.entries = [];
    this.emit(null);
  }

  getEntries(): readonly LogEntry[] {
    return this.entries;
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    listener(this.entries, null);
    return () => this.listeners.delete(listener);
  }

  private emit(latest: LogEntry | null): void {
    for (const listener of this.listeners) listener(this.entries, latest);
  }
}
