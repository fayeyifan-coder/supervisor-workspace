import { useCallback, useState } from "react";
import type { WorkspaceApi } from "./contracts";
import type { StudentRecord, StudentRecordKind } from "./student-records";
import { StudentRecordsPanel } from "./StudentRecordsPanel";

export function TrainingForPlan({ api, studentId, plans, onActivity }: {
  api: WorkspaceApi; studentId: string; plans: StudentRecord[];
  onActivity: (kind: StudentRecordKind, dirty: boolean, busy: boolean) => void;
}) {
  const [selected, setSelected] = useState("");
  const [working, setWorking] = useState({ dirty: false, busy: false });
  const updateActivity = useCallback((kind: StudentRecordKind, dirty: boolean, busy: boolean) => {
    setWorking(value => value.dirty === dirty && value.busy === busy ? value : { dirty, busy });
    onActivity(kind, dirty, busy);
  }, [onActivity]);
  const plan = plans.find(candidate => candidate.id === selected) ?? plans[0];
  if (!plan) return null;
  return <div className="training-for-plan">
    <label>查看方案的训练结果
      <select value={plan.id} disabled={working.busy} onChange={event => {
        if (!working.dirty || window.confirm("训练结果尚未保存，确定切换方案并放弃输入吗？")) setSelected(event.target.value);
      }}>
        {plans.map(item => <option key={item.id} value={item.id}>
          {item.fields.title} · {item.fields.subject} · {item.fields.startsOn} · {item.id.slice(-6)}
        </option>)}
      </select>
    </label>
    <p className="muted">新记录将关联当前方案版本 {plan.revision}。既有训练保留原方案版本。</p>
    <StudentRecordsPanel key={plan.id} api={api} studentId={studentId} kind="training" onActivity={updateActivity}
      fixedFields={{ planId: plan.id, planRevision: String(plan.revision) }}
      filter={row => row.fields.planId === plan.id} />
  </div>;
}
