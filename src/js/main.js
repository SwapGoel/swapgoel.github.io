/**
 * Swapnil Kumar Goel - Main Application Controller
 * Drives the 3D scene from scroll and the education/experience timeline rail.
 */

(function () {
  'use strict';

  window.addEventListener('DOMContentLoaded', () => {
    initScrollOrchestration();
    initTouchHints();
  });

  /**
   * SCROLL ORCHESTRATION
   * The 3D scene is driven by a stage value: section i spans [i, i + 1) and reads i + 0.5
   * when it is centred in the viewport, so every entry stays locked to its scene.
   */
  function initScrollOrchestration() {
    const stages = Array.from(document.querySelectorAll('.story-stage'));

    const update = () => {
      const mid = window.innerHeight / 2;
      let s = 0;
      for (let i = 0; i < stages.length; i++) {
        const r = stages[i].getBoundingClientRect();
        if (mid >= r.bottom) {
          s = i + 1;
          continue;
        }
        if (mid >= r.top) s = i + (mid - r.top) / r.height;
        break;
      }
      if (window.Portfolio3D) window.Portfolio3D.setStage(s);
      document.body.classList.toggle('past-hero', s > 0.85);
      updateTimeline();
    };

    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    window.addEventListener('load', update);
    update();
  }

  /**
   * TIMELINE RAIL
   * One line from the first entry's dot to the last. It scrolls with the page; the lit part
   * runs down to the middle of the viewport, and dots light up as they pass it.
   */
  function updateTimeline() {
    const host = document.getElementById('story-container');
    const rail = document.querySelector('.tl-rail');
    const dots = Array.from(document.querySelectorAll('.tl-dot'));
    if (!host || !rail || dots.length < 2) return;
    const box = host.getBoundingClientRect();
    const centre = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const first = centre(dots[0]);
    const last = centre(dots[dots.length - 1]);
    const top = first.y - box.top;
    const length = last.y - first.y;
    rail.style.left = `${first.x - box.left}px`;
    rail.style.top = `${top}px`;
    rail.style.height = `${length}px`;
    const mid = window.innerHeight / 2;
    rail.firstElementChild.style.height = `${Math.min(length, Math.max(0, mid - first.y))}px`;
    dots.forEach((dot) => dot.classList.toggle('passed', centre(dot).y <= mid + 1));
  }

  /**
   * TOUCH DEVICES: "hover" becomes "touch"
   */
  function initTouchHints() {
    if (!window.matchMedia('(hover: none)').matches) return;
    document.querySelectorAll('.cred-hint').forEach((el) => {
      el.innerHTML = el.innerHTML.replace('fa-mouse-pointer', 'fa-hand-pointer').replace('Hover over', 'Touch');
    });
  }
})();

