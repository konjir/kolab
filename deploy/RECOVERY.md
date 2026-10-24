# Recovering Kolab's database

The targets (P12, D75, D81): a recovery point at RDS's documented guarantee, through point-in-time recovery, and a restore in under 1 hour, proven by a restore drill. RDS uploads the log every 5 minutes, so a restore can lose up to about 5 to 6 minutes of writes, and each drill records the real figure (D81). This runbook is the written procedure, and `deploy/recovery-drill.sh` is the drill. Export per kolab comes later, with the FIL file format.

**Who does what.** Lee, the operator, runs every step from a checkout with the `icedlee337` profile. The one exception is a Terraform apply: once W2.23 has landed, Lee approves it in CI (D73) rather than running it. Before W2.23, Lee runs applies from the laptop, as today. An agent may prepare commands and read their output, but it doesn't run the steps that change production, which are 4 to 7, nor step 2, which creates a billed instance.

## What protects the database

- **Point-in-time recovery.** RDS keeps 7 days of automated backups (`backup_retention_period`, `deploy/terraform/modules/database`): a daily snapshot, plus Postgres's transaction log. A restore can go to any second from the start of those 7 days up to the *latest restorable time*.
- **The recovery point (D81).** AWS documents that RDS uploads the transaction log to S3 every 5 minutes, and that the latest restorable time is typically within the last 5 minutes. So a restore can lose up to about 5 to 6 minutes of writes. That can grow if log archiving stalls, for example when storage is full. Each drill records the real figure: the latest restorable time's lag behind now.
- **What doesn't need a restore.** If the host fails but its storage is intact, RDS recovers the instance in place and loses nothing. Point-in-time recovery is for lost storage, or for data that is wrong.
- **Deletion protection** is on (`db_deletion_protection`), so neither a mistaken `terraform destroy` nor a mistaken `aws rds delete-db-instance` deletes the database.
- **Deleting it anyway keeps the backups.** Terraform keeps a final snapshot and the automated backups (`delete_automated_backups = false`), unless the teardown sets `final_snapshot_on_destroy=false`. The retained backups still allow a point-in-time restore for the rest of their 7 days.

A restore brings back only the database. The rest stays as it is: the admin token, the GitHub OAuth app's id and secret and the CLI's npm spec in SSM, the release on the instance, and the logs. Every write after the recovery point is lost. That includes sessions opened since, because Kolab keeps only their tokens' hashes, so reissue those tokens with `deploy/konjir-ops.sh connect`.

## Runbook

Set these once per shell. Name the environment explicitly: `production`, the only one since D83. `vars` reads that environment's Terraform state, refuses unless the database and its URL's SSM parameter both carry that environment's names, and prints them, with `CHECKED_ENV`. They come from state, so this works when the database itself is gone. If `vars` fails, the old values are cleared first and the last line says to stop, so values from an earlier run can't be reused.

```
cd ~/github.com/konjir/kolab
export AWS_PROFILE=icedlee337 AWS_REGION=us-east-1 AWS_PAGER="" TFENV_TERRAFORM_VERSION=1.16.5
ENV=production
unset DB PARAM SUBNETS SGS CLASS STORAGE RETENTION INSTANCE CHECKED_ENV
V="$(deploy/recovery-drill.sh --env $ENV vars)" && eval "$V"
[ "${CHECKED_ENV:-}" = "$ENV" ] && echo "$ENV: $DB, $PARAM" || echo "STOP: vars failed; nothing is set"
# check them: konjir-test-db and /konjir/konjir-test/database-url for production
NEW=$DB-restore-$(date -u +%Y%m%d-%H%M)
avail() { until [ "$(aws rds describe-db-instances --db-instance-identifier "$1" --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null)" = available ]; do sleep 20; done; }
```

`avail` waits for an instance until it is available. It keeps waiting while the name isn't visible yet, for example just after a rename, and has no 30-minute limit like `aws rds wait`.

| Step | Who | How long |
| --- | --- | --- |
| 0. Stop the damage, and pause deploys | Lee | 5 minutes |
| 1. Choose the point to restore to | Lee | 5 minutes |
| 2. Restore into a new instance | Lee | 15 to 40 minutes, mostly waiting (the drill measures it) |
| 3. Verify the new instance | Lee, with `deploy/recovery-drill.sh verify` | 5 minutes |
| 4. Cut over | Lee | 5 minutes, about 1 of them with Kolab down |
| 5. Roll back (only before step 6) | Lee | 5 minutes |
| 6. Bring Terraform into line, then resume deploys | Lee; after W2.23, Lee approves the apply in CI | 20 minutes, a few with Kolab down |
| 7. Clean up, a week later | Lee | 5 minutes |

Steps 1 to 4 make the hour, measured from the start of step 2. If a release caused the damage, follow [If a release caused it](#if-a-release-caused-it) instead of steps 4 to 6.

### 0. Stop the damage, and pause deploys

If damage is still being done, stop Kolab. Writes made after the chosen point are lost from the restored copy anyway, and they stay in the old instance for inspection.

```
aws ssm send-command --instance-ids $INSTANCE --document-name AWS-RunShellScript --parameters 'commands=["systemctl stop konjir"]'
```

Pause deploys until step 6 is done. A Terraform apply between steps 4 and 6 would point the database URL back at the old instance, and any release would restart Kolab on it.

- **Before W2.23:** applies run only from Lee's laptop. Don't run one.
- **After W2.23:** `.github/workflows/deploy.yml` deploys production once Lee approves it in the `production` environment, and only while the repository variable `DEPLOY_FROM_CI` is `true`. The pause is `DEPLOY_FROM_CI=false`, plus cancelling every run that is pending or waiting: the variable stops new runs from building a release, but a run already past that point would still apply once approved. Don't touch the `production` environment. GitHub has no way to disable one, and deleting it removes its required reviewers: the next run would recreate it without them.

  ```
  gh variable set DEPLOY_FROM_CI --body false
  gh run list --workflow deploy.yml --json databaseId,status --jq '.[] | select(.status != "completed") | .databaseId' \
    | xargs -r -n1 gh run cancel
  ```

  Never approve a production deploy while a recovery is under way.

  **Resuming,** at the end of step 6 or of the release path: `gh variable set DEPLOY_FROM_CI --body true`, then `gh workflow run deploy.yml --ref main`. Setting the variable starts nothing. The run ships whatever is on main, including anything merged during the pause, so check `git log` on main since the last production deploy first.

### 1. Choose the point to restore to

- If the database is lost or broken, restore to its latest restorable time:

  ```
  POINT=$(aws rds describe-db-instances --db-instance-identifier $DB --query 'DBInstances[0].LatestRestorableTime' --output text)
  ```

  If the instance is gone, restore from its retained backups. Earlier instances with the same name, say from a teardown and re-create, may have retained backups too, so list them all, newest first, and choose by resource id and window:

  ```
  aws rds describe-db-instance-automated-backups --db-instance-identifier $DB \
    --query "reverse(sort_by(DBInstanceAutomatedBackups[?Status=='retained'], &RestoreWindow.LatestTime))[].[DbiResourceId,InstanceCreateTime,RestoreWindow.EarliestTime,RestoreWindow.LatestTime]" --output table
  DBI=db-…            # the resource id of the instance that was lost
  POINT=…             # its LatestTime, or an earlier time inside its window
  ```

- If the data is wrong, because of a bad admin call, a runaway cascade or a release, restore to just before it. Find that moment in the logs (`deploy/konjir-ops.sh cloudwatch-logs 24h`), or, for a migration, in `kj_migration.applied_at`. Set it in UTC, for example `POINT=2026-10-22T18:04:00Z`.

`echo $POINT` before going on: it must be a time, not empty or `None`.

### 2. Restore into a new instance

The new instance takes the environment's subnet group, security group, class and storage type, from Terraform's state, so only Kolab's instance can reach it. A restore never writes over the old instance: it always makes a new one.

```
case "${POINT:-None}" in None) echo "STOP: set POINT in step 1" ;; *)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier $DB --target-db-instance-identifier $NEW \
  --restore-time "$POINT" \
  --db-instance-class $CLASS --storage-type $STORAGE \
  --db-subnet-group-name $SUBNETS --vpc-security-group-ids $SGS \
  --no-publicly-accessible --no-multi-az --deletion-protection --copy-tags-to-snapshot --auto-minor-version-upgrade \
  --tags Key=Project,Value=konjir Key=Purpose,Value=recovery Key=Source,Value=$DB ;; esac
avail $NEW
# a restore can't set the backup retention, so set it to Terraform's at once
aws rds modify-db-instance --db-instance-identifier $NEW --backup-retention-period $RETENTION --apply-immediately
```

If the instance is gone, pass `--source-dbi-resource-id $DBI`, the resource id chosen in step 1, in place of `--source-db-instance-identifier $DB`. To use the final snapshot instead, run `aws rds restore-db-instance-from-db-snapshot --db-snapshot-identifier <name>` with the same placement flags.

### 3. Verify the new instance

```
deploy/recovery-drill.sh --env $ENV verify $NEW                         # needs nothing from the old database
deploy/recovery-drill.sh --env $ENV verify $NEW --compare-production    # also compares, if the old database is reachable
```

This runs `deploy/recovery-verify.cjs` on Kolab's instance through SSM, since only that instance can reach the database. It changes nothing. Every session it opens is read-only, with a statement timeout, and it reads the old database's URL there without printing it. It checks:

- **Migrations.** `kj_migration` on the new instance is exactly the live release's: every file the release pins, each with its checksum, and nothing the release doesn't know. If the copy lacks a migration, the live release would apply it on start. That is a failure, and the message names the files. If that release caused the damage, see [If a release caused it](#if-a-release-caused-it). Otherwise, restore to a later point.
- **Tables.** Every table the copy's migrations create is present, and the copy isn't empty.
- **A smoke check, with no write.** A second Kolab from the live release starts on the instance's `127.0.0.1:7499`, against the new instance, with `--no-migrate --no-worker` and a read-only session, and then it stops. It applies no migration and runs no outbox job, and the read-only session would stop any write it tried. It never touches the old database, or the live Kolab on port 7420. Since W2.22, nothing both authenticates and reads through a Kolab without writing: every session is a row whose token Kolab keeps only as a hash, so the copy's sessions can't be presented and a new one can't be opened, and each admin verb the break-glass token runs first writes its audit row (`break_glass.used`), and is refused if it can't. So the check proves the parts apart:
  - it answers `/healthz`, so it started and its database answers;
  - it refuses a token that is no session's with 401, which Kolab answers only after looking the token up in the copy's sessions (a lookup that failed would be a 5xx);
  - it refuses `admin_list_actors` with the break-glass token, because that verb's audit row can't be written to the read-only copy. If the verb ran, the session wasn't read-only or the token's use went unrecorded, and the check fails;
  - then the release's engine, opened read-only on the copy without migrating, lists every actor, as many as the copy holds.
- **With `--compare-production`:** the migrations and the row counts of every table, against the old database. Production has moved on since the chosen point, so its counts may be higher. If the old database can't be reached, the comparison is a note, not a failure.

The output goes to `deploy/drills/verify-<instance>-<time>.log` and ends with `RESULT {…}`. Go on only if that line says `"ok":true`.

### 4. Cut over

Kolab reads its database URL from the SSM parameter when it starts. Point the parameter at the new instance, then restart Kolab. A restore keeps the master password, so only the host changes. The URL never appears on a command line or on disk.

```
OLDHOST=$(aws rds describe-db-instances --db-instance-identifier $DB --query 'DBInstances[0].Endpoint.Address' --output text)   # for step 5; empty if the old instance is gone
NEWHOST=$(aws rds describe-db-instances --db-instance-identifier $NEW --query 'DBInstances[0].Endpoint.Address' --output text)
point_at() {   # rewrites the host in $PARAM's URL, keeping everything else
  aws ssm get-parameter --name $PARAM --with-decryption --query Parameter.Value --output text \
    | python3 -c 'import json,re,sys; u=sys.stdin.read().strip(); print(json.dumps({"Name":sys.argv[1],"Type":"SecureString","Overwrite":True,"Value":re.sub(r"@[^/:]+(:[0-9]+)?/","@"+sys.argv[2]+":5432/",u,count=1)}))' $PARAM "$1" \
    | aws ssm put-parameter --cli-input-json file:///dev/stdin
}
point_at $NEWHOST
aws ssm send-command --instance-ids $INSTANCE --document-name AWS-RunShellScript --parameters 'commands=["systemctl restart konjir"]'
deploy/konjir-ops.sh status    # health ok, and konjir active
```

Then tell people what was lost: the writes after the chosen point, and any sessions opened since. Until step 6, the `rds-cpu-high` and `rds-storage-low` alarms still watch the old instance.

### 5. Roll back (only before step 6)

If the new instance turns out to be wrong, run `point_at $OLDHOST` and restart Kolab as in step 4. This loses the writes made on the new instance since the cutover, so decide quickly.

After step 6, the old instance has been renamed `$OLD` and Terraform holds the new one. Rolling back then means running step 6 in reverse: rename the instances back, then `state rm` and `import` the old one. Treat that as another restore.

### 6. Bring Terraform into line, then resume deploys

Terraform still holds the old instance, under the name `$DB`. Give the new instance that name, and Terraform its state. Do it soon, but at a quiet moment: renaming the new instance changes its address, so Kolab is down for a few minutes. Deploys stay paused throughout.

```
OLD=$DB-old-$(date -u +%Y%m%d)
aws rds modify-db-instance --db-instance-identifier $DB --new-db-instance-identifier $OLD --apply-immediately   # skip if the old instance is gone
avail $OLD
aws rds modify-db-instance --db-instance-identifier $NEW --new-db-instance-identifier $DB --apply-immediately
avail $DB
point_at $(aws rds describe-db-instances --db-instance-identifier $DB --query 'DBInstances[0].Endpoint.Address' --output text)
aws ssm send-command --instance-ids $INSTANCE --document-name AWS-RunShellScript --parameters 'commands=["systemctl restart konjir"]'
deploy/konjir-ops.sh status
```

Then fix the state. After W2.23, run these as `deploy/konjir-ops.sh --env $ENV terraform …`, which uses the environment's own state. Before W2.23, run `terraform -chdir=deploy/terraform …`.

```
terraform state rm module.database.aws_db_instance.this
terraform import module.database.aws_db_instance.this $DB
terraform plan
```

The plan must change the instance in place, never replace it. Expect it to set the master password to the same value (an import can't read it), along with `skip_final_snapshot`, `final_snapshot_identifier`, `delete_automated_backups` and `apply_immediately`, and nothing else of note. The SSM parameter shows no change, because the renamed instance has the original address. If the plan replaces anything, stop and ask.

Then apply:

- **Before W2.23:** Lee applies from the laptop.
- **After W2.23:** Lee resumes deploys as step 0 says (`DEPLOY_FROM_CI=true`, then `gh workflow run deploy.yml --ref main`) and approves the production run, which applies the same plan. The `state rm` and `import` still need write access to the state bucket from Lee's laptop. If W2.23 narrows the laptop's access, they need a way of their own: a break-glass role with write access to the state, assumed with Lee's MFA, or a `workflow_dispatch` job that runs exactly these three commands. That choice belongs to W2.23, and the binding's Today column records it.

### 7. Clean up

Keep the old instance for a week, in case something turns up. Then delete it, keeping a final snapshot:

```
aws rds modify-db-instance --db-instance-identifier $OLD --no-deletion-protection --apply-immediately
aws rds delete-db-instance --db-instance-identifier $OLD --final-db-snapshot-identifier $OLD-final
```

### If a release caused it

Suppose a release did the damage, for example with a migration. Then the live release can't run on the restored copy: it would apply the same migration again. The earlier release can't run on the damaged database either, because it refuses a database migrated past it. So Kolab stays down, even across a reboot, until the restored copy and the earlier release are both in place. Don't use step 6's block here: it restarts Kolab.

1. **Disable Kolab, and pause deploys.** `disable --now` stops it and keeps it stopped if the instance reboots, for example for EC2 maintenance. Don't replace the instance meanwhile: a new one's first boot would start it. Then pause deploys as step 0 says.

   ```
   aws ssm send-command --instance-ids $INSTANCE --document-name AWS-RunShellScript --parameters 'commands=["systemctl disable --now konjir"]'
   ```

2. **Choose and restore.** Choose a point before the release's apply (step 1, using `kj_migration.applied_at`), then restore (step 2).
3. **Verify.** Run step 3 without `--compare-production`. Expect one failure: the copy lacks the bad release's migrations, which the message names, and the smoke check is skipped. Anything else failing is a real problem: stop.
4. **Swap the instances and fix the state, with Kolab still down.** No `point_at` is needed: the renamed instance takes the original address, which the parameter already holds.

   ```
   OLD=$DB-old-$(date -u +%Y%m%d)
   aws rds modify-db-instance --db-instance-identifier $DB --new-db-instance-identifier $OLD --apply-immediately
   avail $OLD
   aws rds modify-db-instance --db-instance-identifier $NEW --new-db-instance-identifier $DB --apply-immediately
   avail $DB
   terraform state rm module.database.aws_db_instance.this          # as in step 6: through konjir-ops.sh after W2.23
   terraform import module.database.aws_db_instance.this $DB
   terraform plan                                                     # in place only, as step 6 says
   ```

5. **Re-enable Kolab, then deploy the earlier release.** On main, revert the release's commits. Re-enable the unit without starting it, so the deploy's install starts the earlier release:

   ```
   aws ssm send-command --instance-ids $INSTANCE --document-name AWS-RunShellScript --parameters 'commands=["systemctl enable konjir"]'
   ```

   Then deploy: before W2.23, Lee applies from the laptop. After it, Lee resumes deploys as step 0 says, and approves that run. The install starts the earlier release, which finds the copy at exactly its migrations. Pause deploys again as soon as the run is done.
6. **Check.** Run `deploy/konjir-ops.sh status`, then a read such as `admin_list_actors`. Keep deploys paused until the release's fix is ready.

Steps 1 to 3 fit in the hour. The revert's deploy adds its own time.

## The drill

```
deploy/recovery-drill.sh --env production
```

The drill is steps 2 and 3 against a scratch instance, followed by its deletion. It never cuts over. It:

1. checks, from the environment's state, that the database and its URL's parameter carry that environment's names. It also checks that the database is available, keeps backups and has a latest restorable time, that Kolab's instance is online in Systems Manager, and that no earlier drill's instance is left over;
2. names the scratch instance `<db>-drill-<UTC date-time>`, for example `konjir-test-db-drill-20261023-1405`, and refuses if that name exists;
3. shows what it will create and what that costs, about $0.02 an hour, and creates nothing until you type the scratch instance's name;
4. restores the latest restorable time into the scratch instance, tagged `Purpose=recovery-drill` and `Source=<db>`, and waits for it, for at most 90 minutes. AWS errors, expired credentials among them, stop it at once, with the cleanup command;
5. verifies it as step 3 does, with the comparison;
6. logs the timings to `deploy/drills/<scratch>.log`: the recovery point's lag behind now, the real figure D81 asks for, and the time from the restore request until the copy is available and until its verification ends, against the hour. The comparison with the hour is about time alone, and the verification's result is stated apart, at the end of the line: `verified in 19m16s (under 60m00s: yes); verification passed`, or, if it failed, `verification ended in 19m16s (under 60m00s: yes); verification FAILED, so this drill doesn't prove the hour`;
7. deletes the scratch instance, without a final snapshot or its automated backups, after you type `delete`. It reads the tags and deletion protection again just before deleting. If the drill stops early, from an error, `^C` or a lost terminal, it prints the cleanup command and offers the same deletion. `deploy/recovery-drill.sh --env production delete <scratch>` deletes it later.

It never modifies the environment's database or any parameter. It only describes the database, restores from its backups, and reads it through read-only sessions. It deletes only an instance named `<db>-drill-…` that carries both of its tags. The second Kolab it starts for the smoke check runs read-only on the Kolab server, on `127.0.0.1:7499`, for under a minute.

Record each drill's summary line in the binding's DEP6 row: its date, the recovery point's lag, the times to available and to the end of verification, and whether the verification passed. Only a drill whose verification passed proves the hour.
