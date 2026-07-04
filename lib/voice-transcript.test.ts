import assert from "node:assert/strict";
import { mergeVoiceTranscript } from "./voice-transcript";

assert.equal(mergeVoiceTranscript("", "hello", ""), "hello");
assert.equal(mergeVoiceTranscript("note: ", "hello world", ""), "note: hello world");

let shown = mergeVoiceTranscript("", "hello", "");
assert.equal(shown, "hello");
shown = mergeVoiceTranscript("", "hello world", shown);
assert.equal(shown, "hello world");

assert.equal(mergeVoiceTranscript("", "", shown), "hello world");
assert.equal(mergeVoiceTranscript("", "hello", shown), "hello world");

shown = mergeVoiceTranscript("", "hello world", "");
assert.equal(mergeVoiceTranscript("", "hello world second phrase", shown), "hello world second phrase");
