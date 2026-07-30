"use client";

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Column,
  type ColumnFiltersState,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowUpDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { selectDisplayLabel } from "@/lib/select-label";

type TableFilter = {
  columnId: string;
  label: string;
  options: Array<{ label: string; value: string }>;
};

export function DataTableColumnHeader<TData>({
  column,
  title,
}: {
  column: Column<TData>;
  title: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-ml-3"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {title}
      <ArrowUpDownIcon aria-hidden="true" />
    </Button>
  );
}

export function DataTable<TData>({
  columns,
  data,
  searchColumn,
  searchPlaceholder,
  filter,
  filters,
  hiddenColumns = [searchColumn],
  emptyMessage,
}: {
  columns: ColumnDef<TData>[];
  data: TData[];
  searchColumn: string;
  searchPlaceholder: string;
  filter?: TableFilter;
  filters?: TableFilter[];
  hiddenColumns?: string[];
  emptyMessage: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  // TanStack Table intentionally returns mutable table methods; React Compiler
  // skips this component instead of memoizing those methods with stale state.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageSize: 8 },
      columnVisibility: Object.fromEntries(
        hiddenColumns.map((columnId) => [columnId, false]),
      ),
    },
  });
  const searchValue =
    (table.getColumn(searchColumn)?.getFilterValue() as string | undefined) ??
    "";
  const activeFilters = [...(filter ? [filter] : []), ...(filters ?? [])];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          name={`${searchColumn}-search`}
          value={searchValue}
          onChange={(event) =>
            table.getColumn(searchColumn)?.setFilterValue(event.target.value)
          }
          placeholder={searchPlaceholder}
          autoComplete="off"
          className="w-full sm:max-w-xs"
        />
        {activeFilters.map((currentFilter) => {
          const value =
            (table.getColumn(currentFilter.columnId)?.getFilterValue() as
              | string
              | undefined) ?? "all";
          return (
            <Select
              key={currentFilter.columnId}
              value={value}
              onValueChange={(nextValue) =>
                table
                  .getColumn(currentFilter.columnId)
                  ?.setFilterValue(
                    nextValue === "all" ? undefined : nextValue,
                  )
              }
            >
              <SelectTrigger
                aria-label={currentFilter.label}
                className="w-full sm:w-44"
              >
                <span className="flex-1 truncate text-left">
                  {selectDisplayLabel(
                    currentFilter.label,
                    currentFilter.options,
                    value,
                  )}
                </span>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  <SelectItem value="all">
                    All {currentFilter.label.toLowerCase()}
                  </SelectItem>
                  {currentFilter.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          );
        })}
      </div>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-28 text-center text-muted-foreground"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
        <p className="tabular-nums">
          {table.getFilteredRowModel().rows.length} results
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
          <span className="min-w-16 text-center tabular-nums">
            {table.getState().pagination.pageIndex + 1} /{" "}
            {Math.max(1, table.getPageCount())}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
