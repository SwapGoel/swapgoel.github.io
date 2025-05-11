document.addEventListener("DOMContentLoaded", () => {
  const words = [
    "Seismology",
    "Signal Processing",
    "Image Processing",
    "Computer Vision"
  ];
  const el = document.getElementById("typed-text");
  const icons = Array.from(document.querySelectorAll(".word-icon"));

  let wordIndex = 0,
      charIndex = 0,
      isDeleting = false;

  const TYPING_SPEED     = 150;
  const DELETING_SPEED   = 80;
  const PAUSE_AFTER_TYPING   = 1200;
  const PAUSE_AFTER_DELETING = 500;
  const MIN_SCALE = 1;      // normal size
  const MAX_SCALE = 1.3;    // how big at full word

  function tick() {
    const word = words[wordIndex];
    // update text
    el.textContent = word.slice(0, charIndex);

    // calculate progress ratio 0→1
    const ratio = word.length
      ? charIndex / word.length
      : 0;

    // pick the icon for this word
    const icon = icons[wordIndex];
    // scale linearly between MIN_SCALE and MAX_SCALE
    const scale = MIN_SCALE + (MAX_SCALE - MIN_SCALE) * ratio;
    // optional: fade from gray→color too
    const grayPct = 100 - (100 * ratio);
    // apply
    icon.style.transform = `scale(${scale})`;
    icon.style.filter    = `grayscale(${grayPct}%) drop-shadow(0 0 ${4 * ratio}px rgba(0,0,0,0.3))`;

    if (!isDeleting) {
      // typing
      if (charIndex < word.length) {
        charIndex++;
        setTimeout(tick, TYPING_SPEED);
      } else {
        // pause then delete
        isDeleting = true;
        setTimeout(tick, PAUSE_AFTER_TYPING);
      }
    } else {
      // deleting
      if (charIndex > 0) {
        charIndex--;
        setTimeout(tick, DELETING_SPEED);
      } else {
        // word fully erased: reset style, advance
        icon.style.transform = ""; 
        icon.style.filter    = "";
        isDeleting = false;
        wordIndex = (wordIndex + 1) % words.length;
        setTimeout(tick, PAUSE_AFTER_DELETING);
      }
    }
  }

  tick();
});
