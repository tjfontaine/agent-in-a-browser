/**
 * Landing Page Interactivity
 * Smooth animations and scroll effects for edge-agent.dev
 */

// Make this file a module to avoid global scope conflicts
export { };

// Intersection Observer for scroll animations
const observeElements = () => {
    const observer = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                }
            });
        },
        {
            threshold: 0.1,
            rootMargin: '0px 0px -50px 0px',
        }
    );

    // Observe feature cards and capabilities
    document.querySelectorAll('.feature-card, .capability').forEach((el) => {
        el.classList.add('animate-on-scroll');
        observer.observe(el);
    });
};

// Terminal typing animation
const animateTerminal = () => {
    const terminalLines = document.querySelectorAll('.terminal-line, .terminal-output');
    terminalLines.forEach((line, index) => {
        (line as HTMLElement).style.animationDelay = `${index * 0.15}s`;
        line.classList.add('terminal-animate');
    });
};

// Smooth scroll for anchor links
const setupSmoothScroll = () => {
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
        anchor.addEventListener('click', (e) => {
            e.preventDefault();
            const target = document.querySelector((anchor as HTMLAnchorElement).getAttribute('href')!);
            target?.scrollIntoView({
                behavior: 'smooth',
                block: 'start',
            });
        });
    });
};

// Nav background on scroll
const setupNavScroll = () => {
    const nav = document.querySelector('.nav');
    if (!nav) return;

    let _lastScroll = 0;
    window.addEventListener('scroll', () => {
        const currentScroll = window.scrollY;

        if (currentScroll > 50) {
            nav.classList.add('nav-scrolled');
        } else {
            nav.classList.remove('nav-scrolled');
        }

        _lastScroll = currentScroll;
    });
};

// Add scroll animation styles
const addAnimationStyles = () => {
    const style = document.createElement('style');
    style.textContent = `
    .animate-on-scroll {
      opacity: 0;
      transform: translateY(20px);
      transition: opacity 0.6s ease, transform 0.6s ease;
    }
    
    .animate-on-scroll.visible {
      opacity: 1;
      transform: translateY(0);
    }
    
    .terminal-animate {
      opacity: 0;
      animation: fadeInUp 0.5s ease forwards;
    }
    
    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    .nav-scrolled {
      background: rgba(26, 27, 38, 0.95) !important;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    }
  `;
    document.head.appendChild(style);
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    addAnimationStyles();
    observeElements();
    animateTerminal();
    setupSmoothScroll();
    setupNavScroll();
});
