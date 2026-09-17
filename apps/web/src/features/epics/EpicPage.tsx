interface EpicPageProps {
  id: string;
}

export default function EpicPage({ id }: EpicPageProps) {
  return (
    <div className="epic-page">
      <h1>Epic: {id}</h1>
      <section aria-label="Epic details">
        <h2>Details</h2>
        <p>Epic configuration and state.</p>
      </section>
    </div>
  );
}
