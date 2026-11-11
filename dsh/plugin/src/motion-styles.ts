export const motionStyles = `
.mf-header-tools{display:grid;justify-items:end;gap:12px;flex-shrink:0}
.mf-motion-mark{border:1px solid transparent;border-radius:4px;background:transparent;color:var(--muted);padding:10px 14px;display:grid;place-items:center;contain:layout paint}
.mf-app .mf-motion-mark:disabled{opacity:1;cursor:default}.mf-app .mf-motion-mark:hover:not(:disabled){border-color:var(--line)}
.mf-dot-field{display:grid;grid-template-columns:repeat(5,8px);grid-auto-rows:8px;gap:5px 7px;align-items:center;justify-items:center}
.mf-dot{display:block;width:6px;height:6px;border-radius:50%;background:var(--text);opacity:.32;transform:scale(.68);animation:mf-pop 3.2s ease-in-out 2 backwards;animation-play-state:paused}
.mf-dot:nth-child(5n+3){background:var(--muted)}.mf-motion-mark[data-running=true] .mf-dot{animation-play-state:running}
@keyframes mf-pop{0%,100%{transform:scale(.68);opacity:.32}42%{transform:scale(1);opacity:.92}70%{transform:scale(.82);opacity:.55}}
.mf-switch-group{border:0;padding:0;margin:28px 0 22px;min-width:0}.mf-switch-group legend{padding:0 0 12px;font-size:13px;font-weight:500;color:var(--muted);width:100%}
.mf-app .mf-switch{display:grid;grid-template-columns:46px minmax(0,1fr) auto;align-items:center;gap:16px;width:100%;min-height:60px;padding:14px 12px;text-align:left;background:transparent;color:var(--text);border:0;border-bottom:1px solid var(--line);border-radius:0}
.mf-app .mf-switch:first-of-type{border-top:1px solid var(--line)}.mf-app .mf-switch:hover:not(:disabled){background:var(--soft);border-color:var(--line)}.mf-app .mf-switch:focus-visible{outline-offset:-2px;border-radius:4px}
.mf-switch-track{position:relative;display:block;width:46px;height:26px;border:1px solid var(--line-strong);border-radius:999px;background:var(--field);overflow:hidden;flex-shrink:0}
.mf-switch-wash{position:absolute;inset:0;border-radius:inherit;background:var(--accent);opacity:0;transition:opacity 200ms ease-out}
.mf-switch-thumb{position:absolute;left:3px;top:2px;width:20px;height:20px;border-radius:50%;background:var(--text);color:var(--bg);transform:translateX(0);transition:transform 220ms cubic-bezier(.22,1,.36,1),background-color 200ms ease;display:grid;place-items:center}
.mf-switch-cross,.mf-switch-tick{grid-area:1/1;font:500 14px/20px var(--sans);text-align:center;transition:opacity 160ms ease-out,transform 200ms ease-out;transform-origin:center}
.mf-switch-cross{opacity:1;transform:rotate(0) scale(1)}.mf-switch-tick{opacity:0;transform:rotate(-35deg) scale(.6)}
.mf-switch[aria-checked=true] .mf-switch-wash{opacity:1}.mf-switch[aria-checked=true] .mf-switch-thumb{transform:translateX(18px);background:var(--on-accent);color:var(--accent)}
.mf-switch[aria-checked=true] .mf-switch-cross{opacity:0;transform:rotate(70deg) scale(.6)}.mf-switch[aria-checked=true] .mf-switch-tick{opacity:1;transform:rotate(0) scale(1)}
.mf-switch-copy{display:grid;gap:2px;min-width:0}.mf-switch-label{font-size:13.5px;font-weight:500;line-height:1.5;overflow-wrap:anywhere}.mf-switch-description{font-size:11.5px;line-height:1.6;color:var(--muted);overflow-wrap:anywhere}.mf-switch-state{color:var(--muted);font:11px var(--mono);white-space:nowrap;min-width:36px;text-align:right}
.mf-app[data-motion=off] .mf-dot{animation:none}.mf-app[data-motion=off] :is(.mf-switch-wash,.mf-switch-thumb,.mf-switch-cross,.mf-switch-tick){transition:none}
@media(prefers-reduced-motion:reduce){.mf-app .mf-dot{animation:none}.mf-app :is(.mf-switch-wash,.mf-switch-thumb,.mf-switch-cross,.mf-switch-tick){transition:none}}
@media(forced-colors:active){.mf-switch-track{border-color:ButtonText}.mf-switch-wash{display:none}.mf-switch-thumb,.mf-switch[aria-checked=true] .mf-switch-thumb{background:ButtonText;color:ButtonFace}.mf-switch-state{color:ButtonText}}
@media(max-width:720px){.mf-header-tools{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:18px}.mf-top .mf-header-tools .mf-flex{margin-top:0}.mf-motion-mark{padding:6px 10px}.mf-switch-group{margin-top:22px}.mf-app .mf-switch{gap:12px;padding:12px 4px}.mf-switch-label{font-size:13.5px}}
@container(max-width:720px){.mf-header-tools{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:18px}.mf-top .mf-header-tools .mf-flex{margin-top:0}.mf-motion-mark{padding:6px 10px}.mf-switch-group{margin-top:22px}.mf-app .mf-switch{gap:12px;padding:12px 4px}.mf-switch-label{font-size:13.5px}}
`;
