/*
    cheap-web-kvm - minimal jQuery widget shims.
    SPDX-License-Identifier: GPL-3.0-or-later

    The application logic inherited from DezKVM-Go drives Fomantic-UI widgets
    through jQuery: 57 toast calls, plus modal/checkbox/dropdown/progress. This
    file reimplements just that API surface against the Tailwind styles in
    app.css, so Fomantic - which was loaded from a CDN, and therefore required
    an internet connection to use a KVM - can be dropped without touching the
    working logic.

    Load after jQuery and before the application scripts.
*/
(function ($) {
    'use strict';

    if (!$) {
        console.error('ui-kit.js requires jQuery');
        return;
    }

    /* ----------------------------------------------------------------- toast */
    const TOAST_CLASS = {
        error: 'kvm-toast-error',
        warning: 'kvm-toast-warning',
        success: 'kvm-toast-success',
        info: '',
    };

    function toastHost() {
        let host = document.getElementById('kvm-toasts');
        if (!host) {
            host = document.createElement('div');
            host.id = 'kvm-toasts';
            document.body.appendChild(host);
        }
        return host;
    }

    function showToast(opts) {
        opts = opts || {};
        const host = toastHost();
        const el = document.createElement('div');
        el.className = 'kvm-toast';
        el.style.position = 'relative';

        const variant = TOAST_CLASS[opts.class];
        if (variant) {
            el.classList.add(variant);
        }

        const body = document.createElement('div');
        body.style.flex = '1';
        // Messages carry inline <i class="... icon"> markup, which app.css
        // renders as masked SVG. It is our own content, not user input.
        body.innerHTML = opts.message || '';
        el.appendChild(body);

        const life = typeof opts.displayTime === 'number' ? opts.displayTime : 3000;

        let bar = null;
        if (opts.showProgress) {
            bar = document.createElement('div');
            bar.className = 'kvm-toast-progress';
            bar.style.width = '100%';
            if (opts.classProgress === 'green') {
                bar.style.background = 'var(--color-live-500)';
            }
            el.appendChild(bar);
        }

        host.appendChild(el);
        requestAnimationFrame(() => el.classList.add('kvm-toast-in'));

        if (bar && life > 0) {
            requestAnimationFrame(() => {
                bar.style.transition = `width ${life}ms linear`;
                bar.style.width = '0%';
            });
        }

        const dismiss = () => {
            if (!el.isConnected) return;
            el.classList.remove('kvm-toast-in');
            setTimeout(() => el.remove(), 200);
        };
        el.addEventListener('click', dismiss);
        if (life > 0) {
            setTimeout(dismiss, life);
        }

        // Never let toasts pile up without bound.
        while (host.children.length > 6) {
            host.firstElementChild.remove();
        }
        return el;
    }

    $.fn.toast = function (opts) {
        showToast(opts);
        return this;
    };
    $.toast = showToast;

    /* -------------------------------------------------------------- checkbox */
    /* Markup is <div class="kvm-toggle" id="xCheckbox"><input type="checkbox"
       id="chkX"><span class="kvm-toggle-track"></span>...</div>. Callers use
       .checkbox('check' | 'uncheck'), and read state from the inner input, so
       the change event has to fire for the inline onchange handlers. */
    $.fn.checkbox = function (action) {
        return this.each(function () {
            const input = this.matches('input[type=checkbox]')
                ? this
                : this.querySelector('input[type=checkbox]');
            if (!input) return;

            if (action === 'check' || action === 'set checked') {
                if (!input.checked) {
                    input.checked = true;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } else if (action === 'uncheck' || action === 'set unchecked') {
                if (input.checked) {
                    input.checked = false;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } else if (action === 'toggle') {
                input.checked = !input.checked;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            // No argument: initialisation. Native inputs need none.
        });
    };

    /* -------------------------------------------------------------- dropdown */
    /* The only dropdown is a native <select>, so this just sets the value and
       lets the element's own onchange run. */
    $.fn.dropdown = function (action, value) {
        return this.each(function () {
            if (action === 'set selected' && value !== undefined) {
                if (this.value !== value) {
                    this.value = value;
                    this.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        });
    };

    /* -------------------------------------------------------------- progress */
    /* Markup is <div class="kvm-progress" id="x"><span class="bar"></span></div> */
    $.fn.progress = function (action, value) {
        return this.each(function () {
            const bar = this.querySelector('.bar');
            if (!bar) return;

            let percent = null;
            if (action === 'set percent') {
                percent = value;
            } else if (action && typeof action === 'object' && 'percent' in action) {
                percent = action.percent;
            }
            if (percent !== null && percent !== undefined) {
                bar.style.width = Math.max(0, Math.min(100, Number(percent))) + '%';
            }
        });
    };

    /* ----------------------------------------------------------------- modal */
    $.fn.modal = function (action) {
        return this.each(function () {
            if (action === 'show') {
                this.classList.add('open');
                this.setAttribute('aria-hidden', 'false');
            } else if (action === 'hide') {
                this.classList.remove('open');
                this.setAttribute('aria-hidden', 'true');
            }
        });
    };

    /* Fomantic's transition plugin is called in a couple of places purely for
       show/hide; map it onto the same open class. */
    $.fn.transition = function (action) {
        return this.each(function () {
            if (typeof action === 'string' && action.indexOf('hide') !== -1) {
                this.classList.remove('open');
            } else if (typeof action === 'string' && action.indexOf('show') !== -1) {
                this.classList.add('open');
            }
        });
    };

    $.fn.popup = function () {
        return this;
    };
    $.fn.tab = function () {
        return this;
    };
})(window.jQuery);
