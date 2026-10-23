# Recovering Kolab's database

The targets (P12, D75): lose under 5 minutes of writes, and be back within 1 hour. RDS point-in-time recovery meets them. This runbook is the written procedure, and `deploy/recovery-drill.sh` is the drill that shows a restore fits in the hour. Export per kolab comes later, with the FIL file format.

Everything here is run by **Lee**, the operator, from a checkout with the `icedlee337` profile. The steps that change production are steps 4 to 7, and step 2 creates a billed instance. An agent may prepare the commands and read the output, but it doesn't run them.

## What protects the database

- **Point-in-time recovery.** RDS keeps 7 days of automated backups (`backup_retention_period`, `deploy/terraform/modules/database`): a daily snapshot, plus Postgres's write-ahead log, which RDS uploads to S3 every 5 minutes. A restore can go to any second from the start of those 7 days up to the *latest restorable time*.
- **The recovery point we can actually achieve.** The latest restorable time trails real time by up to the 5-minute upload interval, so a restore of an instance that just failed loses up to about 5 minutes of writes: typically 2 to 3, and at worst a little over 5, when the failure comes just before an upload. "Under 5 minutes" holds for the typical case, not for every case. Each drill records the lag it found. Nothing cheaper narrows it on RDS. A standby (Multi-AZ, P10, deferred by D74) would remove the loss for a failed instance, but not for a mistake, which replicates.
- **Deletion protection** is on (`db_deletion_protection`), so neither a mistaken `terraform destroy` nor a mistaken `aws rds delete-db-instance` can delete the database.
- **Deleting it anyway keeps the backups.** Terraform keeps a final snapshot and the automated backups (`delete_automated_backups = false`) unless the teardown sets `final_snapshot_on_destroy=false`. The retained backups still allow a point-in-time restore for the rest of their 7 days.

A restore brings back only the database. Everything else stays where it is: the admin token, the GitHub OAuth app's id and secret and the CLI's npm spec in SSM, the release on the instance, and the logs. What a restore loses is every write after the recovery point. That includes sessions opened since, because Kolab stores token hashes, so reissue those tokens with `deploy/konjir-ops.sh connect`.

## Runbook

Set these once per shell, from the checkout:

```
cd ~/github.com/konjir/kolab
export AWS_PROFILE=icedlee337 AWS_REGION=us-east-1 AWS_PAGER=""
TF=deploy/terraform; export TFENV_TERRAFORM_VERSION=1.16.5
PROD=$(terraform -chdir=$TF output -raw database_endpoint); PROD=${PROD%%.*}    # konjir-test-db
PARAM=/konjir/konjir-test/database-url
NEW=$PROD-restore-$(date -u +%Y%m%d-%H%M)
```

| Step | Who | How long |
| --- | --- | --- |
| 1. Choose the point to restore to | Lee | 5 minutes |
| 2. Restore it into a new instance | Lee | 15 to 40 minutes, mostly waiting; the drill measures it |
| 3. Verify the new instance | Lee, with `deploy/recovery-drill.sh verify` | 5 minutes |
| 4. Cut production over | Lee | 5 minutes, about 1 of them with Kolab down |
| 5. Roll back, if the new instance is wrong | Lee | 5 minutes |
| 6. Bring Terraform into line, before the next apply | Lee | 20 minutes, with a few minutes of Kolab down |
| 7. Clean up, a week later | Lee | 5 minutes |

Steps 1 to 4 make the hour, measured from the start of step 2.

### 1. Choose the point to restore to

```
aws rds describe-db-instances --db-instance-identifier $PROD \
  --query 'DBInstances[0].[DBInstanceStatus,LatestRestorableTime,BackupRetentionPeriod]' --output text
```

- If the database is lost or broken, restore to its latest restorable time.
- If the data is wrong, because of a bad migration, a bad admin call or a runaway cascade, restore to a time just before it. Find that time in the logs (`deploy/konjir-ops.sh cloudwatch-logs 24h`). Write it in UTC, for example `2026-10-22T18:04:00Z`.

If damage is still being done, stop Kolab first. Writes made after the chosen point are lost from the restored copy anyway, and they stay in the old instance for inspection.

```
aws ssm send-command --instance-ids $(terraform -chdir=$TF output -raw instance_id) \
  --document-name AWS-RunShellScript --parameters 'commands=["systemctl stop konjir"]'
```

### 2. Restore into a new instance

The new instance takes production's subnet group, security group and class, so only Kolab's instance can reach it. Never restore over production: a restore always makes a new instance.

```
SUBNETS=$(aws rds describe-db-instances --db-instance-identifier $PROD --query 'DBInstances[0].DBSubnetGroup.DBSubnetGroupName' --output text)
SGS=$(aws rds describe-db-instances --db-instance-identifier $PROD --query 'DBInstances[0].VpcSecurityGroups[].VpcSecurityGroupId' --output text)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier $PROD --target-db-instance-identifier $NEW \
  --restore-time 2026-10-22T18:04:00Z \
  --db-instance-class db.t4g.micro --db-subnet-group-name $SUBNETS --vpc-security-group-ids $SGS \
  --no-publicly-accessible --no-multi-az --deletion-protection --copy-tags-to-snapshot \
  --tags Key=Project,Value=konjir Key=Purpose,Value=recovery Key=Source,Value=$PROD
aws rds wait db-instance-available --db-instance-identifier $NEW    # gives up after 30 minutes; run it again
```

Use `--use-latest-restorable-time` in place of `--restore-time` to restore to the latest point.

If production's instance is gone, restore from its retained backups. Look up its resource id with `aws rds describe-db-instance-automated-backups --query 'DBInstanceAutomatedBackups[].[DBInstanceIdentifier,DbiResourceId,RestoreWindow]'`, then run the same restore command with `--source-dbi-resource-id <db-…>` in place of `--source-db-instance-identifier`. To restore the final snapshot instead, use `aws rds restore-db-instance-from-db-snapshot --db-snapshot-identifier <name>`, which takes the same placement flags.

### 3. Verify the new instance

```
deploy/recovery-drill.sh verify $NEW
```

This runs `deploy/recovery-verify.cjs` on Kolab's instance through SSM, since only that instance can reach the database. It reads production's URL there, never prints it, and opens read-only sessions. It checks three things:

- **Migrations.** `kj_migration` in the new instance has every checksum as the live release pins it (`libs/db/src/migrations/checksums.json`), and the same rows as production. If a deploy migrated production after the chosen point, it says so.
- **Row counts.** It counts every table in both. Production has moved on since the chosen point, so its counts may be higher. A table missing from the new instance, or an empty new instance, fails.
- **A smoke check.** A second Kolab, from the live release, starts on the instance's `127.0.0.1:7499` against the new instance. It must answer `/healthz` and `admin_list_actors`, and then it stops. It never touches production's database or the live Kolab on port 7420.

The output is in `deploy/drills/verify-<instance>-<time>.log`, and it ends with `RESULT {…}`. Go on only if that line says `"ok":true`.

### 4. Cut production over

Kolab reads its database URL from the SSM parameter when it starts. Point the parameter at the new instance, then restart Kolab. The password is the same, because a restore keeps the master password, so only the host changes. The URL never appears on a command line or on disk.

```
NEWHOST=$(aws rds describe-db-instances --db-instance-identifier $NEW --query 'DBInstances[0].Endpoint.Address' --output text)
aws ssm get-parameter --name $PARAM --with-decryption --query Parameter.Value --output text \
  | python3 -c 'import json,re,sys; u=sys.stdin.read().strip(); print(json.dumps({"Name":sys.argv[1],"Type":"SecureString","Overwrite":True,"Value":re.sub(r"@[^/:]+(:[0-9]+)?/","@"+sys.argv[2]+":5432/",u,count=1)}))' $PARAM $NEWHOST \
  | aws ssm put-parameter --cli-input-json file:///dev/stdin
aws ssm send-command --instance-ids $(terraform -chdir=$TF output -raw instance_id) \
  --document-name AWS-RunShellScript --parameters 'commands=["systemctl restart konjir"]'
deploy/konjir-ops.sh status    # health ok, and konjir active
```

Before running it, note the old host so that you can roll back: `OLDHOST=$(aws rds describe-db-instances --db-instance-identifier $PROD --query 'DBInstances[0].Endpoint.Address' --output text)`. Then tell people what was lost: the writes after the chosen point, and any sessions opened since.

Until step 6, the `rds-cpu-high` and `rds-storage-low` alarms still watch the old instance, and a `terraform apply` would point the parameter back at it. Don't apply before step 6.

### 5. Roll back

If the new instance turns out wrong, run step 4's commands with `$OLDHOST` in place of `$NEWHOST`. Rolling back loses the writes made on the new instance since the cutover, so decide quickly. The old instance is untouched until step 6 renames it.

### 6. Bring Terraform into line

Terraform still holds the old instance, under the name `$PROD`. Give the new instance that name, and Terraform its state. Do it at a quiet time: renaming the new instance changes its address, so Kolab is down for a few minutes.

```
OLD=$PROD-old-$(date -u +%Y%m%d)
aws rds modify-db-instance --db-instance-identifier $PROD --new-db-instance-identifier $OLD --apply-immediately
aws rds wait db-instance-available --db-instance-identifier $OLD      # the rename takes a minute or two
aws rds modify-db-instance --db-instance-identifier $NEW --new-db-instance-identifier $PROD --apply-immediately
aws rds wait db-instance-available --db-instance-identifier $PROD
NEWHOST=$(aws rds describe-db-instances --db-instance-identifier $PROD --query 'DBInstances[0].Endpoint.Address' --output text)
# then step 4's put-parameter and restart, with this NEWHOST: Kolab is back up
terraform -chdir=$TF state rm module.database.aws_db_instance.this
terraform -chdir=$TF import module.database.aws_db_instance.this $PROD
terraform -chdir=$TF plan
```

The plan should change the instance in place, never replace it. Expect it to set the master password to the same value (an import can't read it), the backup settings and tags, and nothing else of note. If the plan replaces the instance, stop and ask. Once the plan is right, apply it. Since D73, applies run from CI after Lee approves them (W2.23). The `state rm` and `import` are still Lee's, from a laptop with access to the state.

### 7. Clean up

Keep the old instance for a week, in case something turns up. Then delete it, keeping a final snapshot:

```
aws rds modify-db-instance --db-instance-identifier $OLD --no-deletion-protection --apply-immediately
aws rds delete-db-instance --db-instance-identifier $OLD --final-db-snapshot-identifier $OLD-final
```

## The drill

```
deploy/recovery-drill.sh
```

The drill is steps 2 and 3 against a scratch instance, followed by its deletion. It never cuts over. It:

1. checks that production is available, keeps backups, and has a latest restorable time, and that Kolab's instance is online in Systems Manager;
2. names the scratch instance `<production>-drill-<UTC date-time>`, for example `konjir-test-db-drill-20261023-1405`, and refuses if that name exists;
3. shows what it will create and what that costs, about $0.02 an hour, and creates nothing until you type the scratch instance's name;
4. restores production's latest restorable time into the scratch instance, tagged `Purpose=recovery-drill`, and waits for it, for at most 90 minutes;
5. verifies it as step 3 does;
6. logs the timings to `deploy/drills/<scratch>.log`: the recovery point's lag behind now, against the 5-minute target, and the time from the restore request until the copy is available and until it is verified, against the hour;
7. deletes the scratch instance, without a final snapshot or its automated backups, after you type `delete`. If the drill stops early, from an error or `^C`, it offers the same deletion. If it is declined, `deploy/recovery-drill.sh delete <scratch>` deletes it later.

It never modifies production's instance or any parameter. It only describes production, restores from its backups, and reads it through read-only sessions. It deletes only an instance named `<production>-drill-…` that carries its tag. The second Kolab it starts for the smoke check runs on the production server, on `127.0.0.1:7499`, for under a minute.

Record each drill's summary line in the binding's DEP6 row: its date, the recovery point's lag, and the times to available and to verified.
