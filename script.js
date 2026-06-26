// Gallery filter
document.querySelectorAll('.filter-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var filter = btn.getAttribute('data-filter');

    document.querySelectorAll('.filter-btn').forEach(function (b) {
      var active = b === btn;
      b.style.background = active ? '#16140F' : '#fff';
      b.style.color = active ? '#F3F1EA' : '#5a564e';
      b.style.borderColor = active ? '#16140F' : '#E7E4DC';
    });

    document.querySelectorAll('.gallery-item').forEach(function (item) {
      var show = filter === 'Vše' || item.getAttribute('data-tag') === filter;
      item.style.display = show ? '' : 'none';
    });
  });
});

// Contact form (static demo — no backend, just shows a success state)
var form = document.getElementById('contact-form');
var success = document.getElementById('form-success');
var resetBtn = document.getElementById('form-reset');

if (form) {
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    form.style.display = 'none';
    success.style.display = 'flex';
  });
}

if (resetBtn) {
  resetBtn.addEventListener('click', function () {
    form.reset();
    success.style.display = 'none';
    form.style.display = 'flex';
  });
}

// Mobile nav: close menu after tapping a link
var mainNav = document.getElementById('mainNav');
var navToggle = document.getElementById('navToggle');

if (mainNav && navToggle) {
  mainNav.querySelectorAll('a').forEach(function (link) {
    link.addEventListener('click', function () {
      mainNav.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
      navToggle.textContent = '☰';
    });
  });
}
