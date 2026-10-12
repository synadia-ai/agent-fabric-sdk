export {
  nativeScratchPad,
  nativeScratchPadFromEnv,
  NativeScratchPad,
  type NativeScratchPadOptions,
  type PublishOptions,
  type PublishResult,
  type RecoveryResult,
  type VolumeReleaseOutcome,
} from "./scratchpad-native/client";
export {
  scratchPadReader,
  ScratchPadReader,
  DEFAULT_READ_LIMIT_BYTES,
  type ScratchPadReaderOptions,
  type ReadBytesOptions,
} from "./scratchpad-native/reader";
export { NativeScratchPadError } from "./scratchpad-native/errors";
export { encodeReference, decodeReference, type Reference } from "./scratchpad-native/codec";
export { decodeShortReference, type ShortReference } from "./scratchpad-native/references";
export type {
  AdmissionBinding,
  LifetimeView,
  RenewRequest,
  RemovalRequest,
  RemovalPlan,
  VolumeReleaseRequest,
  VolumeReleasePlan,
  VolumeReleaseResult,
  ReleaseEffects,
} from "./scratchpad-native/protocol";
