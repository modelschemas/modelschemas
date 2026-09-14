/**
 * Hand-written rate cards ported from Openstory (openstory-so/openstory#1606),
 * keyed by endpoint / model id. Test data only — not exported from the
 * package and not served.
 */
import type { RateCard } from '../rate-card.schema.ts'
import { BYTEPLUS_SEEDANCE_2_5 } from './byteplus-seedance-2-5.ts'
import {
  BYTEPLUS_SEEDANCE_2_0,
  BYTEPLUS_SEEDANCE_2_0_MINI,
} from './byteplus-seedance-2-0.ts'
import { BYTEPLUS_SEEDREAM_5_0_PRO } from './byteplus-seedream-5-0-pro.ts'
import {
  GPT_IMAGE_2_5_FLARE_EDIT,
  GPT_IMAGE_2_5_FLARE_TEXT_TO_IMAGE,
} from './gpt-image-2-5-flare-text-to-image.ts'
import { GPT_4O } from './gpt-4o.ts'
import { GROK_IMAGINE_VIDEO_REFERENCE_TO_VIDEO } from './grok-imagine-video-reference-to-video.ts'
import {
  H3_MAX_IMAGE_TO_VIDEO,
  H3_MAX_TEXT_TO_VIDEO,
} from './h3-max-image-to-video.ts'
import { H3_MAX_REFERENCE_TO_VIDEO } from './h3-max-reference-to-video.ts'
import { KLING_V3_PRO_IMAGE_TO_VIDEO } from './kling-v3-pro-image-to-video.ts'
import { NANO_BANANA_2 } from './nano-banana-2.ts'
import { SEEDANCE_FAL_RATE_CARDS } from './seedance-fal.ts'

export const FIXTURE_CARDS: Readonly<Record<string, RateCard>> = {
  'openai/gpt-4o': GPT_4O,
  'fal-ai/kling-video/v3/pro/image-to-video': KLING_V3_PRO_IMAGE_TO_VIDEO,
  'xai/grok-imagine-video/v1.5/reference-to-video':
    GROK_IMAGINE_VIDEO_REFERENCE_TO_VIDEO,
  'minimax/h3-max/image-to-video': H3_MAX_IMAGE_TO_VIDEO,
  'minimax/h3-max/text-to-video': H3_MAX_TEXT_TO_VIDEO,
  'minimax/h3-max/reference-to-video': H3_MAX_REFERENCE_TO_VIDEO,
  'fal-ai/nano-banana-2': NANO_BANANA_2,
  'openai/gpt-image-2.5/flare/text-to-image': GPT_IMAGE_2_5_FLARE_TEXT_TO_IMAGE,
  'openai/gpt-image-2.5/flare/edit': GPT_IMAGE_2_5_FLARE_EDIT,
  ...SEEDANCE_FAL_RATE_CARDS,
  'dreamina-seedance-2-5-260628': BYTEPLUS_SEEDANCE_2_5,
  'dreamina-seedance-2-0-260128': BYTEPLUS_SEEDANCE_2_0,
  'dreamina-seedance-2-0-mini-260615': BYTEPLUS_SEEDANCE_2_0_MINI,
  'dola-seedream-5-0-pro-260628': BYTEPLUS_SEEDREAM_5_0_PRO,
}
