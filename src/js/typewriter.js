document.addEventListener("DOMContentLoaded", () => {
  const words = ["Seismology","Signal Processing","Image Processing","Computer Vision"];
  const el = document.getElementById("typed-text");
  if (!el) return console.error("Span #typed-text not found");

  let wordIndex = 0, charIndex = 0, isDeleting = false;
  const TYPING_SPEED = 150;
  const DELETING_SPEED = 80;
  const PAUSE_AFTER_TYPING = 1200;  // ms pause when a word is fully typed
  const PAUSE_AFTER_DELETING = 500;  // ms pause when a word is fully deleted

  function tick() {
    const currentWord = words[wordIndex];

    // update the displayed substring
    el.textContent = currentWord.slice(0, charIndex);

    if (!isDeleting) {
      // TYPING
      if (charIndex < currentWord.length) {
        charIndex++;
        setTimeout(tick, TYPING_SPEED);
      } else {
        // fully typed → pause, then start deleting
        isDeleting = true;
        setTimeout(tick, PAUSE_AFTER_TYPING);
      }

    } else {
      // DELETING
      if (charIndex > 0) {
        charIndex--;
        setTimeout(tick, DELETING_SPEED);
      } else {
        // fully deleted → pause, then go to next word and start typing
        isDeleting = false;
        wordIndex = (wordIndex + 1) % words.length;
        setTimeout(tick, PAUSE_AFTER_DELETING);
      }
    }
  }

  tick();
});
