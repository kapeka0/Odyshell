import { TablePageSkeleton } from "@/components/dashboard-skeletons";

export default function ActivityLoading() {
  return <TablePageSkeleton columns={5} filters={3} />;
}
