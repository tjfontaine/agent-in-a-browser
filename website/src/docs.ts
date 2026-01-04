/**
 * Documentation Page Interactivity
 * Sidebar navigation highlighting and smooth scrolling
 */

// Make this file a module to avoid global scope conflicts
export { };

// Highlight active section in sidebar based on scroll position
const setupScrollSpy = () => {
    const sections = document.querySelectorAll('section[id], h2[id]');
    const navLinks = document.querySelectorAll('.sidebar-links a');

    if (sections.length === 0 || navLinks.length === 0) return;

    const observer = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    const id = entry.target.getAttribute('id');
                    navLinks.forEach((link) => {
                        link.classList.remove('active');
                        if (link.getAttribute('href') === `#${id}`) {
                            link.classList.add('active');
                        }
                    });
                }
            });
        },
        {
            rootMargin: '-80px 0px -60% 0px',
            threshold: 0,
        }
    );

    sections.forEach((section) => observer.observe(section));
};

// Smooth scroll for sidebar links
const setupSmoothScroll = () => {
    document.querySelectorAll('.sidebar-links a').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = (link as HTMLAnchorElement).getAttribute('href');
            const target = document.querySelector(targetId!);
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                });
                // Update URL without scrolling
                history.pushState(null, '', targetId);
            }
        });
    });
};

// Copy code blocks on click
const setupCodeCopy = () => {
    document.querySelectorAll('.code-block pre').forEach((block) => {
        block.addEventListener('click', async () => {
            const code = block.textContent || '';
            try {
                await navigator.clipboard.writeText(code);
                // Visual feedback
                block.classList.add('copied');
                setTimeout(() => block.classList.remove('copied'), 1000);
            } catch (err) {
                console.error('Failed to copy:', err);
            }
        });
        (block as HTMLElement).style.cursor = 'pointer';
        (block as HTMLElement).title = 'Click to copy';
    });

    // Add copy feedback style
    const style = document.createElement('style');
    style.textContent = `
    .code-block pre.copied {
      outline: 2px solid var(--color-accent-green);
      outline-offset: -2px;
    }
  `;
    document.head.appendChild(style);
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupScrollSpy();
    setupSmoothScroll();
    setupCodeCopy();
});
