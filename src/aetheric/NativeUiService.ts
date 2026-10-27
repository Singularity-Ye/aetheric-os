const SHELL_CLASS = "aetheric-os-shell-active";

export class NativeUiService {
  private enabled = false;

  apply(enabled: boolean): void {
    this.enabled = enabled;
    // Avoid invalidating the whole Obsidian document when duplicate workspace
    // events request the layout state that is already applied.
    if (document.body.classList.contains(SHELL_CLASS) !== enabled) {
      document.body.classList.toggle(SHELL_CLASS, enabled);
    }
  }

  restore(): void {
    this.apply(false);
  }

  isApplied(): boolean {
    return this.enabled && document.body.classList.contains(SHELL_CLASS);
  }
}
