/**
 * GET /admin/complaints — read-only list of open entry complaints.
 *
 * Gated on ctx.admin (staff + owner). No actions here yet — this is purely a
 * triage view so staff can see what readers have flagged and click through to
 * the entry. Resolving/dismissing a complaint is a TODO (would be an owner-only
 * POST mutating complaints.status).
 */
import { h, type SafeHtml } from "../../html.ts";
import { layout } from "../../layout.ts";
import { query } from "../../db.ts";
import { formatEahId } from "../../eah-id.ts";
import { tokenForRequest } from "../../csrf.ts";
import { htmlResponse, type RouteContext } from "../types.ts";
import { COMPLAINT_TYPES } from "../complaint.ts";

const TYPE_LABELS = new Map(COMPLAINT_TYPES.map((t) => [t.key, t.label]));

interface ComplaintRow {
  id: number;
  complaint_type: string;
  body: string;
  created_at: Date;
  eah_number: number | null;
  reporter_username: string | null;
}

function fmtDate(d: Date | string): string {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function authRedirect(): Response {
  return new Response(null, { status: 303, headers: { Location: "/login" } });
}

export async function getComplaints(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();

  const { token: csrfToken, setCookie } = tokenForRequest(req);

  const rows = await query<ComplaintRow>(
    `SELECT c.id, c.complaint_type, c.body, c.created_at,
            s.eah_number, u.username AS reporter_username
       FROM complaints c
       JOIN submissions s ON s.id = c.submission_id
       LEFT JOIN users u  ON u.id = c.reporter_user_id
      WHERE c.status = 'open'
      ORDER BY c.created_at DESC
      LIMIT 1000`,
  );

  const tableBody: SafeHtml = rows.length === 0
    ? h`<p><em>No open complaints.</em></p>`
    : h`
        <table class="queue">
          <thead>
            <tr>
              <th>filed</th>
              <th>entry</th>
              <th>type</th>
              <th>from</th>
              <th>note</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => {
              const eahId = formatEahId(r.eah_number);
              return h`
                <tr>
                  <td>${fmtDate(r.created_at)}</td>
                  <td>${eahId
                    ? h`<a href="/e/${eahId}"><code>${eahId}</code></a>`
                    : h`<em>(gone)</em>`}</td>
                  <td>${TYPE_LABELS.get(r.complaint_type) ?? r.complaint_type}</td>
                  <td>${r.reporter_username ?? h`<em>anonymous</em>`}</td>
                  <td style="white-space:pre-wrap">${r.body}</td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      `;

  const body = h`
    <p>${rows.length} open complaint${rows.length === 1 ? "" : "s"} from readers.
       Resolving/dismissing isn't wired up yet — for now this is a triage view.</p>
    ${tableBody}
  `;

  const html = await layout({
    title: "Complaints",
    heading: "Open complaints",
    body,
    user: ctx.user,
    csrfToken,
    bodyClass: "admin-wide",
  });
  return htmlResponse(html, { setCookie });
}
