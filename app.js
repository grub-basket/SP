/* Stashpad showcase — no dependencies. */
(function () {
  "use strict";

  // --- Screenshot hydration -------------------------------------------------
  // Each <figure class="shot" data-shot="NAME" data-cap="..."> tries to load
  // screenshots/NAME.png. If it exists, show the image; otherwise render a
  // labeled placeholder. To add a real screenshot, just drop a PNG at
  // screenshots/NAME.png — no HTML editing needed.
  function placeholder(fig, name, cap) {
    const ph = document.createElement("div");
    ph.className = "shot-ph";
    ph.innerHTML =
      '<div class="cam">📷</div>' +
      '<div class="name">screenshots/' + name + ".png</div>" +
      '<div class="cap">' + (cap || "") + "</div>";
    fig.appendChild(ph);
    if (cap) {
      const fc = document.createElement("figcaption");
      fc.textContent = cap;
      fig.appendChild(fc);
    }
  }

  document.querySelectorAll("figure.shot[data-shot]").forEach(function (fig) {
    const name = fig.getAttribute("data-shot");
    const cap = fig.getAttribute("data-cap") || "";
    const img = new Image();
    img.alt = cap;
    img.loading = "lazy";
    img.onload = function () {
      fig.appendChild(img);
      if (cap) {
        const fc = document.createElement("figcaption");
        fc.textContent = cap;
        fig.appendChild(fc);
      }
    };
    img.onerror = function () { placeholder(fig, name, cap); };
    img.src = "screenshots/" + name + ".png";
  });

  // --- Mobile sidebar -------------------------------------------------------
  const sidebar = document.getElementById("sidebar");
  const scrim = document.getElementById("scrim");
  const menuBtn = document.getElementById("menuBtn");
  function closeMenu() { sidebar.classList.remove("open"); scrim.classList.remove("show"); }
  if (menuBtn) menuBtn.addEventListener("click", function () {
    sidebar.classList.toggle("open");
    scrim.classList.toggle("show");
  });
  if (scrim) scrim.addEventListener("click", closeMenu);
  document.querySelectorAll("#toc a").forEach(function (a) {
    a.addEventListener("click", closeMenu);
  });

  // --- Scrollspy (highlight active section in the TOC) ----------------------
  const links = Array.prototype.slice.call(document.querySelectorAll("#toc a"));
  const byId = {};
  links.forEach(function (a) {
    const id = a.getAttribute("href").slice(1);
    if (id) byId[id] = a;
  });
  const sections = Array.prototype.slice.call(document.querySelectorAll("main section[id]"));
  let current = null;
  const obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        const a = byId[e.target.id];
        if (a && a !== current) {
          if (current) current.classList.remove("active");
          a.classList.add("active");
          current = a;
        }
      }
    });
  }, { rootMargin: "-20% 0px -70% 0px", threshold: 0 });
  sections.forEach(function (s) { obs.observe(s); });
})();
