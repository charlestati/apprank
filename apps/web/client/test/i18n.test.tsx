/* oxlint-disable vitest/require-top-level-describe -- the storage reset is a
   file-wide precondition shared by every suite below. */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  I18nProvider,
  LanguagePicker,
  fmt,
  initialLang,
  reasonText,
  useT,
} from "../src/i18n";
import type { Dictionary } from "../src/i18n";

beforeEach(() => {
  // Unstub first: a previous test may have replaced localStorage with one that
  // throws, and clearing it before restoring would fail here instead of there.
  vi.unstubAllGlobals();
  localStorage.clear();
});

function Probe() {
  const t = useT();
  return <p>{t.whatToWorkOn}</p>;
}

describe(fmt, () => {
  it("fills named placeholders", () => {
    expect(fmt("{n} of {total}", { n: 3, total: 25 })).toBe("3 of 25");
  });

  it("leaves an unknown placeholder visible rather than blanking it", () => {
    // A silently empty slot reads as a real value of nothing; a visible
    // "{oops}" is obviously a bug.
    expect(fmt("{a} {oops}", { a: 1 })).toBe("1 {oops}");
  });
});

describe(initialLang, () => {
  it("prefers a stored choice over the browser's", () => {
    localStorage.setItem("apprank.lang", "fr");
    vi.stubGlobal("navigator", { language: "en-US" });
    expect(initialLang()).toBe("fr");
  });

  it("falls back to the browser language", () => {
    vi.stubGlobal("navigator", { language: "fr-FR" });
    expect(initialLang()).toBe("fr");
    vi.stubGlobal("navigator", { language: "de-DE" });
    expect(initialLang()).toBe("en");
  });

  it("ignores a stored value that is not a supported language", () => {
    localStorage.setItem("apprank.lang", "klingon");
    vi.stubGlobal("navigator", { language: "en-GB" });
    expect(initialLang()).toBe("en");
  });

  it("survives storage that throws, as it does in some privacy modes", () => {
    vi.stubGlobal("navigator", { language: "en-GB" });
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    vi.stubGlobal("localStorage", broken);
    expect(initialLang()).toBe("en");
  });
});

describe(reasonText, () => {
  const t = { reasonWinning: "Gagné" } as unknown as Dictionary;

  it("translates a known reason key", () => {
    expect(reasonText(t, "winning", "English fallback")).toBe("Gagné");
  });

  it("falls back to the API prose for a key this build does not know", () => {
    // A verdict added server-side must read oddly, never disappear.
    expect(reasonText(t, "somethingNew", "English fallback")).toBe(
      "English fallback"
    );
    expect(reasonText(t, undefined, "English fallback")).toBe(
      "English fallback"
    );
  });
});

describe(LanguagePicker, () => {
  it("switches the interface and remembers the choice", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    render(
      <I18nProvider>
        <LanguagePicker />
        <Probe />
      </I18nProvider>
    );
    expect(screen.getByText("What to work on")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "fr" } });

    expect(screen.getByText("Sur quoi travailler")).toBeTruthy();
    expect(localStorage.getItem("apprank.lang")).toBe("fr");
  });

  it("sets the document language, so screen readers switch voice too", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    render(
      <I18nProvider>
        <LanguagePicker />
      </I18nProvider>
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "fr" } });
    expect(document.documentElement.lang).toBe("fr");
  });
});
