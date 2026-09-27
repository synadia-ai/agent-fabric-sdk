export {
  nativeScratchPad,
  nativeScratchPadFromEnv,
  NativeScratchPad,
  type NativeScratchPadOptions,
  type PublishOptions,
  type PublishResult,
  type RecoveryResult,
} from "./scratchpad-native/client";
export {
  scratchPadReader,
  ScratchPadReader,
  DEFAULT_READ_LIMIT_BYTES,
  type ScratchPadReaderOptions,
  type ReadBytesOptions,
} from "./scratchpad-native/reader";
export { NativeScratchPadError } from "./scratchpad-native/errors";
