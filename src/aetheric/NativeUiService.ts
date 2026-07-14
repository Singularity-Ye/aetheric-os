const SHELL_CLASS = "aetheric-os-shell-active";

export class NativeUiService {
  private enabled = false;

  apply(enabled: boolean): void {
    this.enabled = enabled;
    document.body.classList.toggle(SHELL_CLASS, enabled);
  }

  restore(): void {
    this.apply(false);
  }

  isApplied(): boolean {
    return this.enabled && document.body.classList.contains(SHELL_CLASS);
  }
}
