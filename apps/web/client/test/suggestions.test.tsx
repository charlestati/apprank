import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Suggestions } from "../src/pages/suggestions";
import { stubFetch, suggestion } from "./harness";

describe("Suggestions page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading placeholder first", () => {
    stubFetch({ suggestions: [] });
    render(<Suggestions />);
    expect(screen.getByText("Loading…")).toBeDefined();
  });

  it("explains the empty inbox", async () => {
    stubFetch({ suggestions: [] });
    render(<Suggestions />);
    await expect(screen.findByText(/Inbox empty/u)).resolves.toBeDefined();
  });

  it("treats a failed request as an empty inbox", async () => {
    stubFetch({ suggestions: new Response("", { status: 401 }) });
    render(<Suggestions />);
    await expect(screen.findByText(/Inbox empty/u)).resolves.toBeDefined();
  });

  it("lists the type and raw payload of each pending suggestion", async () => {
    stubFetch({
      suggestions: [
        suggestion({ id: 1 }),
        suggestion({
          id: 2,
          payload: '{"keyword":"another keyword"}',
          type: "promote_storefront",
        }),
      ],
    });
    render(<Suggestions />);
    await expect(screen.findByText("promote_keyword")).resolves.toBeDefined();
    expect(screen.getByText("promote_storefront")).toBeDefined();
    expect(screen.getByText('{"keyword":"another keyword"}')).toBeDefined();
    expect(screen.queryByText(/Inbox empty/u)).toBeNull();
  });
});
