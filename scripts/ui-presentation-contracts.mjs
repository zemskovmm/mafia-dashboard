// Pure presentation oracles; importing this module never launches a browser.
export function assertCanonicalProjection(domain, getActiveBranch, state) {
  const replay = domain.replayGameLog(
    state.initialGame,
    getActiveBranch(state.events, state.headEventId),
  );
  if (domain.hashGameState(replay.game) !== domain.hashGameState(state.game)) {
    throw new Error("Persisted UI state does not equal canonical replay");
  }
  return replay.frames;
}

export function resolveUiMode(env) {
  const supported = new Set(
    [
      "HEADER",
      "PRIVACY",
      "HARDENING",
      "RULES_SKETCHBOOK",
      "FEDERATION",
      "SIDE_PANEL",
      "LAYOUT",
      "MUSIC",
    ].map((mode) => `UI_${mode}_ONLY`),
  );
  const selected = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("UI_") || !key.endsWith("_ONLY")) continue;
    if (!supported.has(key)) throw new Error(`Unknown verifier mode ${key}`);
    if (!["", "0", "1"].includes(value)) throw new Error(`${key} must be 0 or 1`);
    if (value === "1") selected.push(key);
  }
  const children = selected.filter((key) => ["UI_PRIVACY_ONLY", "UI_HARDENING_ONLY"].includes(key));
  if (children.length && env.UI_HEADER_ONLY !== "1") {
    throw new Error(`${children.join(", ")} requires UI_HEADER_ONLY=1`);
  }
  if (selected.length - (children.length ? 1 : 0) > 1) {
    throw new Error(`Conflicting verifier modes: ${selected.join(", ")}`);
  }
  if (env.UI_RULES_SKETCHBOOK_ONLY === "1") return "rules-sketchbook";
  if (env.UI_FEDERATION_ONLY === "1") return "federation";
  if (env.UI_SIDE_PANEL_ONLY === "1") return "side-panel";
  if (env.UI_LAYOUT_ONLY === "1") return "layout";
  if (env.UI_HEADER_ONLY === "1") {
    if (env.UI_HARDENING_ONLY === "1") return "hardening";
    if (env.UI_PRIVACY_ONLY === "1") return "privacy";
    return "header";
  }
  if (env.UI_MUSIC_ONLY === "1") return "music";
  return "default";
}

export function assertCardSizes(cards) {
  const reference = cards[0];
  if (!reference) throw new Error("Expected table cards");
  for (const card of cards) {
    const expectedScale = card.emphasized ? 1.2 : card.voted ? 0.88 : 1;
    if (
      ![card.layoutWidth, card.layoutHeight, card.width, card.height, card.scale].every(
        (value) => Number.isFinite(value) && value > 0,
      ) ||
      Math.abs(card.layoutWidth - reference.layoutWidth) > 0.5 ||
      Math.abs(card.layoutHeight - reference.layoutHeight) > 0.5 ||
      Math.abs(card.scale - expectedScale) > 0.001 ||
      Math.abs(card.width - card.layoutWidth * card.scale) > 0.5 ||
      Math.abs(card.height - card.layoutHeight * card.scale) > 0.5
    ) {
      throw new Error(`Card size mismatch: ${JSON.stringify(card)}`);
    }
  }
}

export function assertBalancedCardPlacement(
  workspace,
  cards,
  label = "table",
  { compactLandscape = false, phase } = {},
) {
  // Compact public daytime layouts reserve fixed space for the lower action
  // stacks. Check the original orbit, not equality of those deliberate insets.
  const offsets =
    compactLandscape &&
    [
      "day",
      "voting",
      "goodbye-speech",
      "car-crash-decision",
      "car-crash-result",
      "car-crash-skipped",
      "voting-cancelled",
    ].includes(phase)
      ? { 1: -14, 2: -8, 9: -8, 10: -14, ...(phase === "day" ? { 5: 2, 6: 2 } : {}) }
      : {};
  const placements = cards.map((card) => {
    if (!Number.isFinite(card.scale) || card.scale <= 0) {
      throw new Error(`${label}: invalid card scale`);
    }
    // The actual rendered bounds still own clipping checks. Only grid centering
    // excludes the intentional, center-origin speaker/voter scale.
    const inset = ((card.bottom - card.top) * (1 - 1 / card.scale)) / 2;
    const offset = offsets[card.seat] ?? 0;
    return { top: card.top + inset - offset, bottom: card.bottom - inset - offset };
  });
  const top = Math.min(...placements.map((card) => card.top)) - workspace.top;
  const bottom = workspace.bottom - Math.max(...placements.map((card) => card.bottom));
  if (!(Math.abs(top - bottom) <= 2)) {
    throw new Error(`${label}: unequal top/bottom clearance`);
  }
}

export function assertRailMaterial(evidence) {
  const opaque =
    /^rgb\([^/]*\)$/.test(evidence.background) && !evidence.background.includes("rgba");
  const scene =
    evidence.status === "ready" &&
    evidence.sceneVisible &&
    evidence.sceneWidth > 0 &&
    evidence.sceneHeight > 0 &&
    evidence.painted;
  const fallback =
    ["off", "inactive", "unavailable", "context-lost"].includes(evidence.status) &&
    evidence.backdrop.includes("blur");
  if (
    evidence.reducedTransparency
      ? evidence.status === "reduced-transparency" && opaque
      : scene || fallback
  )
    return;
  throw new Error(`Rail material unavailable: ${JSON.stringify(evidence)}`);
}

export function assertPlayerLighting(evidence) {
  if (evidence.active && evidence.opacity > 0.99 && evidence.visibility === "visible") {
    if (
      evidence.effective === "legacy" &&
      (evidence.reducedMotion || evidence.animation !== "none") &&
      evidence.shadow !== "none" &&
      !["none", "normal"].includes(evidence.content)
    )
      return;
    if (evidence.effective === "vgpu" && evidence.ready === "true" && evidence.canvasOpacity > 0.99)
      return;
  }
  throw new Error(`Player lighting unavailable: ${JSON.stringify(evidence)}`);
}
