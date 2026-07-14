import { AethericShellState } from "./types";

type StoreListener = (state: Readonly<AethericShellState>) => void;

export class AethericStore {
  private state: AethericShellState;
  private listeners = new Set<StoreListener>();
  private onPersist: (state: AethericShellState) => void;

  constructor(initialState: AethericShellState, onPersist: (state: AethericShellState) => void) {
    this.state = structuredClone(initialState);
    this.onPersist = onPersist;
  }

  getSnapshot(): Readonly<AethericShellState> {
    return this.state;
  }

  patch(patch: Partial<AethericShellState>, persist = true): void {
    this.state = { ...this.state, ...patch };
    this.emit();
    if (persist) this.onPersist(structuredClone(this.state));
  }

  update(mutator: (state: AethericShellState) => AethericShellState, persist = true): void {
    this.state = mutator(structuredClone(this.state));
    this.emit();
    if (persist) this.onPersist(structuredClone(this.state));
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
