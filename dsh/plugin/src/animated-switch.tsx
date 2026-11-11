import { useId } from "react";

/** A controlled draft field: native button keyboard behavior, no implicit submit. */
export function AnimatedSwitch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  onText = "已开启",
  offText = "已关闭",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  onText?: string;
  offText?: string;
}) {
  const descriptionId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={description ? descriptionId : undefined}
      className="mf-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="mf-switch-track" aria-hidden="true">
        <span className="mf-switch-wash" />
        <span className="mf-switch-thumb">
          <span className="mf-switch-cross">×</span>
          <span className="mf-switch-tick">√</span>
        </span>
      </span>
      <span className="mf-switch-copy">
        <span className="mf-switch-label">{label}</span>
        {description && (
          <span className="mf-switch-description" id={descriptionId}>
            {description}
          </span>
        )}
      </span>
      <span className="mf-switch-state" aria-hidden="true">
        {checked ? onText : offText}
      </span>
    </button>
  );
}
