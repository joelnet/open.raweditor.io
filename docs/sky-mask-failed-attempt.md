# Sky selection mask: failed attempt (2026-06)

Status: **abandoned and reverted** (never merged). This documents the approach
and why it failed so a future attempt doesn't retrace it.

## Goal

A "+ Sky" mask type alongside the linear/radial gradient masks: automatic
per-pixel sky selection so tone adjustments can target the sky. Analysis ran
once per opened file in a worker, produced a preview-resolution weight plane
uploaded as a `u_skyM` texture; export bilinearly upsampled the same plane so
preview and export matched by construction.

## Approach (classical CV, no ML)

Pipeline lived in `src/tone/sky-math.js` (+ `sky-worker.js`, `sky-client.js`),
all on a ≤320px analysis grid, display-referred (sRGB-encoded):

1. **Border detection**: Shen & Wang 2013 ("Sky Region Detection in a Single
   Image for Autonomous Ground Robot Navigation"): sweep ~120 Sobel gradient
   thresholds (5..600 in 8-bit units); each threshold's border is the first
   per-column gradient crossing (sky must touch the top edge).
2. **Deviations from the paper**, both tuned on real photos:
   - Ranked candidates by **Fisher's two-class separation** (Δμᵀ·Σpooled⁻¹·Δμ
     of sky vs. ground color) instead of the paper's covariance-homogeneity
     energy, which preferred a degenerate few-rows strip of clean sky over
     the true horizon once clouds textured the sky (~2% margin, flipped by
     sensor noise).
   - Added **flat horizontal lines** to the candidate pool, since cloud edges
     block the per-column gradient scan.
3. **No-sky tests**: the paper's border-shape tests (border hugging the top,
   shallow + jagged border), plus a Luo & Etz 2002-style color plausibility
   prior: accepted sky must be bright (mean encoded luma ≥ 0.35) or
   decisively blue (B > 1.25·R and 1.25·G). Without this, Fisher separation
   accepts any strong color split (lit indoor wall over dark floor).
4. **Soft classification**: border seeds two Gaussian color models
   (sky/ground); pixels above a horizon (95th-percentile border depth) get
   the equal-prior posterior plus a vertical position bias (logit +2 at the
   top fading to 0). Below the horizon: never sky (keeps water reflections
   out).
5. **Refinement**: guided filter (He et al. 2010, same recipe as the dehaze
   transmission refinement); coefficients joint-upsampled against the
   preview's encoded luma for an edge-aware mask at preview resolution.

## Why it failed

**The mask was too inaccurate too often: it over-selected or under-selected
the sky on real images.** No single tunable was at fault; the failure was
systemic:

- The gradient-border premise (one sky/ground boundary per column, sky
  touching the top edge) is too rigid for real photos: clouds, haze,
  backlit foliage, and buildings cutting the skyline all break it.
- The two-Gaussian color posterior can't separate sky from similarly
  colored ground content (gray clouds vs. gray buildings/pavement, warm
  sunset sky vs. warm-lit ground). The position prior papers over this but
  introduces its own over-selection near the top of the frame.
- Threshold constants (SEP_MIN, SKY_MIN_LUMA, BLUE_MARGIN, no-sky tests)
  were each tuned to fix a specific false positive/negative, and every fix
  shifted errors elsewhere. The parameter space had no setting that was
  right often enough.

Per-image tuning could rescue individual photos, but a mask feature must be
right nearly always with zero user parameters; classical heuristics on a
320px grid didn't reach that bar.

## Ideas for a future attempt

- **Semantic segmentation model** (ONNX Runtime Web / WebGPU): a small
  sky-segmentation or scene-parsing net (e.g. trained on ADE20K sky class)
  sidesteps the color/gradient ambiguity entirely. Cost: model download,
  inference time, WebGPU/wasm complexity on this host (Raspberry Pi;
  check perf).
- **Depth-estimation models** (e.g. Depth Anything small): sky is at
  infinite depth; thresholding far depth may be more robust than color.
- **Keep the guided-filter refinement**: the edge-aware upsampling and the
  preview/export-share-one-plane architecture worked; only the coarse
  detection was the problem. Any future detector can slot into the same
  worker → weight plane → `u_skyM` plumbing.
- If staying classical: interactive seeding (user taps the sky, grow region
  from there) trades full automation for reliability.

## References

- Shen & Wang 2013, *Sky Region Detection in a Single Image for Autonomous
  Ground Robot Navigation*
- Luo & Etz 2002, *A physical model-based approach to detecting sky in
  photographic images*
- He, Sun & Tang 2010, *Guided Image Filtering*
