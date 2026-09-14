const sections = ['Dashboard', 'Projects', 'AI Capacity', 'Machines', 'Tasks'];

export function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Sonoran Solutions</p>
          <h1>Sonoran Hub</h1>
        </div>
        <span className="status-pill">Foundation scaffold</span>
      </header>

      <div className="workspace">
        <nav aria-label="Primary navigation" className="sidebar">
          {sections.map((section, index) => (
            <a
              className={index === 0 ? 'nav-item active' : 'nav-item'}
              href={`#${section}`}
              key={section}
            >
              {section}
            </a>
          ))}
        </nav>

        <main className="content">
          <section className="hero" id="Dashboard">
            <p className="eyebrow">Control plane</p>
            <h2>A calm place to see what needs your attention.</h2>
            <p>
              Sonoran Hub is the control plane for Sonoran Solutions development workflows. This
              initial shell is ready for the project, capacity, machine, and task surfaces that
              follow.
            </p>
          </section>

          <section aria-label="Hub areas" className="section-grid">
            {sections.slice(1).map((section) => (
              <article className="placeholder-card" id={section} key={section}>
                <span className="card-index">0{sections.indexOf(section) + 1}</span>
                <h3>{section}</h3>
                <p>Placeholder surface for the next implementation phase.</p>
              </article>
            ))}
          </section>
        </main>
      </div>
    </div>
  );
}
