import { Badge, Button } from "@fluentui/react-components";
import { CheckmarkCircle24Regular, Dismiss24Regular, ErrorCircle24Regular } from "@fluentui/react-icons";
import type { HealthResponse } from "../types/api";

type HealthBannerProps = {
  health: HealthResponse | null;
  loading: boolean;
  dismissed: boolean;
  onDismiss: () => void;
};

export function HealthBanner({ health, loading, dismissed, onDismiss }: HealthBannerProps) {
  if (dismissed) {
    return null;
  }

  if (loading) {
    return (
      <div className="healthBanner neutral">
        <Badge appearance="filled">Checking</Badge>
        <span>Checking local backend and Ollama status...</span>
      </div>
    );
  }

  const running = Boolean(health?.ollama_running);

  return (
    <div className={`healthBanner ${running ? "ok" : "error"}`}>
      <div className="healthContent">
        {running ? <CheckmarkCircle24Regular /> : <ErrorCircle24Regular />}
        <span>
          {running
            ? `Ollama running | Model: ${health?.primary_model ?? "qwen2.5:14b"}`
            : "Ollama not running - run: ollama serve"}
        </span>
      </div>
      {!running && (
        <Button
          appearance="subtle"
          icon={<Dismiss24Regular />}
          aria-label="Dismiss health warning"
          onClick={onDismiss}
        />
      )}
    </div>
  );
}
