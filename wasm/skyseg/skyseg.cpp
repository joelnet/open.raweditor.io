// ncnn glue for the sky-segmentation wasm module (see build.sh).
//
// Wraps the U²-NetP sky model from
// https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing
// (skysegsmall_sim-opt-fp16, MIT) behind two C exports:
//
//   skyseg_load(param, bin)      — load the ncnn graph + fp16 weights once
//   skyseg_run(rgb, size, out)   — 3×size×size planar CHW float in,
//                                  size×size float sky probability out
//
// The caller (src/tone/sky-worker.js) does all pre/post-processing —
// ImageNet normalization in, guided-filter refinement out — so this file
// stays a dumb inference shim. Blob names match the model's own demo code
// (ncnn_interence.cpp): input "input.1", output "1959" (sigmoid(d0)).

#include "net.h"
#include "datareader.h"

#include <cstring>

namespace {
ncnn::Net g_net;
bool g_loaded = false;
} // namespace

extern "C" {

// param must be NUL-terminated text (the worker appends the NUL); bin is
// the raw .bin bytes. Both buffers must stay alive for the module's
// lifetime: ncnn's ModelBin copies weight blobs on load, but keeping them
// is cheap insurance against zero-copy paths. Returns 0 on success.
__attribute__((used)) int skyseg_load(const unsigned char* param,
                                      const unsigned char* bin) {
  if (g_loaded) return 0;
  g_net.opt.num_threads = 1; // wasm build is single-threaded (no COI)
  g_net.opt.use_vulkan_compute = false;
  const unsigned char* p = param;
  ncnn::DataReaderFromMemory pr(p);
  if (g_net.load_param(pr) != 0) return -1;
  const unsigned char* b = bin;
  ncnn::DataReaderFromMemory br(b);
  if (g_net.load_model(br) != 0) return -2;
  g_loaded = true;
  return 0;
}

// rgb: 3×size×size floats, planar CHW, already (v − mean)/std normalized.
// out: size×size floats, the model's sigmoid output (≈ [0, 1]).
// Returns 0 on success.
__attribute__((used)) int skyseg_run(const float* rgb, int size, float* out) {
  if (!g_loaded) return -1;
  // Wrapping external data requires ncnn's packed layout: cstep == w·h,
  // which holds exactly when w·h·4 bytes is 16-aligned — true for any
  // multiple of 2 (384·384·4 = 589824). Copy instead of aliasing anyway:
  // extractors may recycle input blobs in light mode.
  ncnn::Mat in(size, size, 3);
  if (in.empty()) return -2;
  std::memcpy(in.data, rgb, sizeof(float) * 3 * size * size);
  ncnn::Extractor ex = g_net.create_extractor();
  ex.set_light_mode(true);
  if (ex.input("input.1", in) != 0) return -3;
  ncnn::Mat prob;
  if (ex.extract("1959", prob) != 0) return -4;
  if (prob.w != size || prob.h != size) return -5;
  std::memcpy(out, prob.data, sizeof(float) * size * size);
  return 0;
}

} // extern "C"
