import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiClient } from "../../src/api/client.js";
import ProjectConfigPanel from "../../src/features/projects/ProjectConfigPanel.js";

afterEach(() => vi.restoreAllMocks());

describe("Project Config review panel", () => {
  it("shows the persisted source diff and approves exactly its candidate/hash", async () => {
    const candidate = { candidateId: "candidate-1", projectId: "project-1", sourceHead: "abc123", manifestHash: "a".repeat(64), files: { ".ebb-orchestrator/project.yaml": "schema_version: 1\nproject:\n  name: sample\n  default_branch: main\n" }, manifest: [{ path: ".ebb-orchestrator/project.yaml", state: "present", sha256: "b".repeat(64) }, { path: ".ebb-orchestrator/guidelines/old.md", state: "deleted", sha256: null }], status: "PENDING_REVIEW", createdAt: "2026-09-29T00:00:00.000Z" };
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ current: candidate, active: { revisionId: "old", manifestHash: "c".repeat(64), revisionHash: "d".repeat(64), files: { ".ebb-orchestrator/guidelines/old.md": "Retired guideline" } }, revisions: [] });
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ active: { revisionId: "revision-1", manifestHash: candidate.manifestHash, revisionHash: "b".repeat(64) } });
    render(<ProjectConfigPanel projectId="project-1" />);
    await screen.findByText(candidate.manifestHash);
    expect(screen.getByText(/default_branch/)).toBeInTheDocument();
    expect(screen.getByText(/guidelines\/old\.md/)).toBeInTheDocument();
    expect(screen.getByText(/Удалён/)).toBeInTheDocument();
    expect(screen.getByText("Retired guideline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Одобрить эту конфигурацию" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      "/projects/project-1/config/candidates/candidate-1/approve",
      { manifestHash: candidate.manifestHash },
    ));
    expect(get).toHaveBeenCalled();
  });

  it("keeps the action unavailable when no reviewable candidate exists", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({ current: null, active: null });
    render(<ProjectConfigPanel projectId="project-2" />);
    await screen.findByText(/нет ожидающей конфигурации/i);
    expect(screen.queryByRole("button", { name: /Одобрить эту конфигурацию/i })).not.toBeInTheDocument();
  });

  it("keeps verified revision history accessible when the active revision is degraded", async () => {
    const revision = { revisionId: "revision-1", manifestHash: "a".repeat(64), revisionHash: "b".repeat(64), normalizedConfig: {} };
    vi.spyOn(apiClient, "get").mockResolvedValue({ current: null, active: null, revisions: [revision], degraded: true });
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ candidate: { candidateId: "rollback-1" } });
    render(<ProjectConfigPanel projectId="project-3" />);
    expect(await screen.findByText(/запуск проекта заблокирован/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Подготовить rollback" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/project-3/config/revisions/revision-1/rollback", {}));
  });
});
