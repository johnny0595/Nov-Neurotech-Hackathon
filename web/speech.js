// Read-aloud with the browser's built-in speechSynthesis (no services). Off by default; settings:
// speechOn, speechRate (0.5-2), speechVolume (0-1), speechVoice (voice name, "" = system default).
// Every call cancels whatever was being said, so the newest thing always wins.
import { settings } from "./settings.js";

const synth = globalThis.speechSynthesis;

/** Text as it should be spoken: no markup, no emoji or arrow symbols (voices read their names aloud). */
export function speakable(text) {
  return String(text)
    .replace(/<br\s*\/?>/gi, ". ")
    .replace(/<[^>]+>/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{FE0F}\u{2500}-\u{257F}]/gu, "")
    .replace(/\s*·\s*/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

export const supported = Boolean(synth);

export function voices() {
  return synth ? synth.getVoices() : [];
}

export function speak(text, { force = false } = {}) {
  if (!synth || (!settings.speechOn && !force)) return;
  const words = speakable(text);
  if (!words) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(words);
  u.rate = Number(settings.speechRate) || 1;
  u.volume = Math.max(0, Math.min(1, Number(settings.speechVolume ?? 1)));
  const voice = voices().find((v) => v.name === settings.speechVoice);
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  synth.speak(u);
}

export function stop() {
  synth?.cancel();
}
