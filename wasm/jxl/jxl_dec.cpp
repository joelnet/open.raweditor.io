// Minimal JPEG XL → uint16 decode wrapper around libjxl, for the JXL
// payloads inside DNG 1.7 raws (see src/decode/dng.js). One codestream in,
// one interleaved uint16 RGB(A)/gray buffer out — no ICC handling beyond
// libjxl's own output conversion, no animation, no threads.
//
// Exported (see build.sh):
//   jxl_decode(data, size) -> 0 on success, negative on failure
//   jxl_width() / jxl_height() / jxl_channels() -> result geometry
//   jxl_colorimetric() -> 1 when the result is already linear sRGB
//   jxl_pixels() -> pointer into the wasm heap (u16, w*h*channels)
//   jxl_release() -> free the result buffer
//
// Callers drive it through src/decode/jxl-worker.js.

#include <jxl/cms.h>
#include <jxl/decode.h>

#include <cstdint>
#include <cstdlib>

namespace {
uint16_t *g_pixels = nullptr;
uint32_t g_width = 0;
uint32_t g_height = 0;
uint32_t g_channels = 0;
uint32_t g_colorimetric = 0;
} // namespace

extern "C" {

void jxl_release() {
  std::free(g_pixels);
  g_pixels = nullptr;
  g_width = g_height = g_channels = 0;
  g_colorimetric = 0;
}

int jxl_decode(const uint8_t *data, size_t size) {
  jxl_release();

  JxlDecoder *dec = JxlDecoderCreate(nullptr);
  if (!dec) return -1;

  int rc = -2;
  bool uses_original_profile = true;
  if (JxlDecoderSetCms(dec, *JxlGetDefaultCms()) != JXL_DEC_SUCCESS) {
    goto done;
  }
  if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO |
                                         JXL_DEC_COLOR_ENCODING |
                                         JXL_DEC_FULL_IMAGE) !=
      JXL_DEC_SUCCESS) {
    goto done;
  }
  JxlDecoderSetInput(dec, data, size);
  JxlDecoderCloseInput(dec);

  for (;;) {
    JxlDecoderStatus status = JxlDecoderProcessInput(dec);
    switch (status) {
    case JXL_DEC_BASIC_INFO: {
      JxlBasicInfo info;
      if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS) {
        rc = -3;
        goto done;
      }
      g_width = info.xsize;
      g_height = info.ysize;
      g_channels = info.num_color_channels; // 1 (gray) or 3 (RGB)
      uses_original_profile = info.uses_original_profile;
      break;
    }
    case JXL_DEC_COLOR_ENCODING: {
      // Two kinds of payload, told apart by uses_original_profile:
      //
      //  - Lossless (modular) passthrough: the stored samples come back
      //    bit-exact. In a DNG these are raw camera-space values whose
      //    meaning comes from the container tags (BlackLevel, ColorMatrix,
      //    AsShotNeutral, ...) — the caller must develop them.
      //
      //  - XYB (lossy): the samples were colorimetric on encode — XYB
      //    cannot represent anything else — so the codestream's color
      //    encoding fully describes them and the DNG develop must NOT be
      //    applied (Lightroom's lossy-JXL DNGs are written this way).
      //    Convert straight to the app's working space, linear sRGB.
      if (uses_original_profile) break;
      JxlColorEncoding enc;
      enc.color_space =
          g_channels == 1 ? JXL_COLOR_SPACE_GRAY : JXL_COLOR_SPACE_RGB;
      enc.white_point = JXL_WHITE_POINT_D65;
      enc.primaries = JXL_PRIMARIES_SRGB;
      enc.transfer_function = JXL_TRANSFER_FUNCTION_LINEAR;
      enc.rendering_intent = JXL_RENDERING_INTENT_RELATIVE;
      if (JxlDecoderSetOutputColorProfile(dec, &enc, nullptr, 0) !=
          JXL_DEC_SUCCESS) {
        rc = -10;
        goto done;
      }
      g_colorimetric = 1;
      break;
    }
    case JXL_DEC_NEED_IMAGE_OUT_BUFFER: {
      JxlPixelFormat format = {g_channels, JXL_TYPE_UINT16,
                               JXL_LITTLE_ENDIAN, 0};
      size_t needed = 0;
      if (JxlDecoderImageOutBufferSize(dec, &format, &needed) !=
          JXL_DEC_SUCCESS) {
        rc = -4;
        goto done;
      }
      g_pixels = static_cast<uint16_t *>(std::malloc(needed));
      if (!g_pixels) {
        rc = -5;
        goto done;
      }
      if (JxlDecoderSetImageOutBuffer(dec, &format, g_pixels, needed) !=
          JXL_DEC_SUCCESS) {
        rc = -6;
        goto done;
      }
      // Passthrough samples keep the codestream's range (e.g. 12-bit
      // 0..4095) because the DNG's BlackLevel/WhiteLevel are in those
      // units. Colorimetric output has no "stored units" — leave it on
      // the default full uint16 scale.
      if (!g_colorimetric) {
        JxlBitDepth depth = {JXL_BIT_DEPTH_FROM_CODESTREAM, 0, 0};
        if (JxlDecoderSetImageOutBitDepth(dec, &depth) != JXL_DEC_SUCCESS) {
          rc = -9;
          goto done;
        }
      }
      break;
    }
    case JXL_DEC_FULL_IMAGE:
      break; // keep going; SUCCESS follows for stills
    case JXL_DEC_SUCCESS:
      rc = g_pixels ? 0 : -7;
      goto done;
    default:
      rc = -8; // JXL_DEC_ERROR or an unexpected event
      goto done;
    }
  }

done:
  JxlDecoderDestroy(dec);
  if (rc != 0) jxl_release();
  return rc;
}

uint32_t jxl_width() { return g_width; }
uint32_t jxl_height() { return g_height; }
uint32_t jxl_channels() { return g_channels; }
/** 1 if the result is already linear sRGB (XYB codestream — do not apply
 * the DNG develop), 0 if it is raw passthrough samples. */
uint32_t jxl_colorimetric() { return g_colorimetric; }
uint16_t *jxl_pixels() { return g_pixels; }

} // extern "C"
