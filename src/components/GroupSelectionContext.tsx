"use client";

import { createContext, useContext } from "react";

/**
 * Selection state shared between the toolbar and the table rows.
 *
 * The rows are rendered by the server page, so they cannot hold this state
 * themselves - a context is what lets a checkbox inside a row and the toolbar
 * above the table be the same selection without lifting the whole table into
 * one client component.
 */
export interface GroupSelectionState {
  selecting: boolean;
  selected: ReadonlySet<number>;
  toggle: (id: number) => void;
  /** Rows already in a group cannot be selected; a transaction has at most one. */
  groupNameFor: (id: number) => string | null;
}

export const GroupSelectionContext = createContext<GroupSelectionState | null>(null);

export function useGroupSelection(): GroupSelectionState | null {
  return useContext(GroupSelectionContext);
}
