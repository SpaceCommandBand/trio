# Trio (Space Command Band Fork)

This is a fork of [PaulBatchelor/Trio](https://github.com/PaulBatchelor/Trio) —
a singing synthesizer musical instrument with algorithmic 3-part harmony,
written using WebAudio, Canvas, WebAssembly, and Rust.

See the original project for documentation and demos:
https://github.com/PaulBatchelor/Trio

## Changes in this fork

- Refactored chord manager to use 12 chromatic major chords instead of diatonic triads
- Added `chord_select` field to `ChordManager` for direct candidate indexing
- Added `vox_set_chord_select()` WASM export
- Removed web frontend files (superseded by the Space Command Band website integration)
