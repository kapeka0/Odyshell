import { TablePageSkeleton } from "@/components/dashboard-skeletons";

export default function MachinesLoading() {
  return <TablePageSkeleton columns={5} rowSubtitle toolbarAction />;
}
