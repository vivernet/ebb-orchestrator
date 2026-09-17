interface ProjectPageProps {
  id: string;
}

export default function ProjectPage({ id }: ProjectPageProps) {
  return (
    <div className="project-page">
      <h1>Project: {id}</h1>
      <section aria-label="Project details">
        <h2>Details</h2>
        <p>Project configuration and state.</p>
      </section>
    </div>
  );
}
