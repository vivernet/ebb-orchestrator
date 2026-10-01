import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiClient } from "../../src/api/client.js";
import HumanFeedbackPanel from "../../src/features/projects/HumanFeedbackPanel.js";

afterEach(() => vi.restoreAllMocks());

describe("Project HumanFeedback inbox", () => {
  it("renders source body as text and supports triage actions scoped to the project", async () => {
    const item = { id: "feedback-1", body: "<script>alert(1)</script>", sourceUrl: "https://github.com/owner/repo/issues/7#issuecomment-9", sourceIssueNumber: 7, sourceCommentId: 9, authorLogin: "reviewer", status: "UNTRIAGED" };
    vi.spyOn(apiClient, "get").mockImplementation(async (path) => path.endsWith("/github/mapping") ? { repository: "owner/repo" } : { items: [item] } as never);
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ item: { ...item, status: "LINKED" } });
    render(<HumanFeedbackPanel projectId="project-1" tasks={[{ id: "task-1", title: "Task one" }]} epics={[]} />);
    await screen.findByText(item.body);
    expect(document.querySelector("script")).toBeNull();
    fireEvent.change(screen.getByLabelText("Связать с задачей или эпиком"), { target: { value: "TASK:task-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Связать" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/project-1/human-feedback/feedback-1/link", { targetType: "TASK", targetId: "task-1" }));
  });

  it("exposes explicit sync and persistent delete action", async () => {
    vi.spyOn(apiClient, "get").mockImplementation(async (path) => path.endsWith("/github/mapping") ? { repository: "owner/repo" } : { items: [{ id: "f-2", body: "Please review", sourceUrl: "https://github.com/owner/repo/issues/3#issuecomment-4", sourceIssueNumber: 3, sourceCommentId: 4, authorLogin: "reviewer", status: "UNTRIAGED" }] } as never);
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ status: "COMPLETE" });
    render(<HumanFeedbackPanel projectId="project-2" tasks={[]} epics={[]} />);
    await screen.findByText("Please review");
    fireEvent.click(screen.getByRole("button", { name: "Синхронизировать сейчас" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/project-2/github/sync", {}));
    fireEvent.click(screen.getByRole("button", { name: "Удалить feedback" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/project-2/human-feedback/f-2/delete", {}));
  });

  it("loads the next inbox page with the opaque cursor", async () => {
    const first = { id: "f-1", body: "First comment", sourceUrl: "https://github.com/owner/repo/issues/1", sourceIssueNumber: 1, sourceCommentId: 1, authorLogin: "reviewer", status: "UNTRIAGED" };
    const second = { ...first, id: "f-2", body: "Second comment", sourceCommentId: 2 };
    const get = vi.spyOn(apiClient, "get").mockImplementation(async (path) => {
      if (path.endsWith("/github/mapping")) return { repository: "owner/repo" } as never;
      return path.includes("cursor=opaque-token") ? { items: [second], nextCursor: null } as never : { items: [first], nextCursor: "opaque-token" } as never;
    });
    render(<HumanFeedbackPanel projectId="project-4" tasks={[]} epics={[]} />);
    await screen.findByText("First comment");
    fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));
    await screen.findByText("Second comment");
    expect(get).toHaveBeenCalledWith("/projects/project-4/human-feedback?status=UNTRIAGED&cursor=opaque-token");
  });
});
