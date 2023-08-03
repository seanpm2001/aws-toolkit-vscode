/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { CredentialsSettings } from './credentials/utils'
import { telemetry } from '../shared/telemetry/telemetry'
import { Auth } from './auth'
import { IamConnection, isIamConnection } from './connection'
import { ToolkitError } from '../shared/errors'
import { promptForConnection } from './utils'

export class CredentialsInjector implements vscode.TerminalProfileProvider {
    readonly #disposables = [] as vscode.Disposable[]

    public constructor(
        private readonly collection: vscode.EnvironmentVariableCollection,
        private readonly settings = new CredentialsSettings(),
        private readonly auth = Auth.instance
    ) {
        collection.persistent = false

        this.#disposables.push(
            this.settings.onDidChange(async ({ key }) => {
                if (key === 'injectCredentials') {
                    await this.handleUpdate()
                }
            }),
            this.auth.onDidChangeActiveConnection(conn => this.handleUpdate(conn))
        )
    }

    public get enabled() {
        return this.settings.get('injectCredentials', true)
    }

    public async provideTerminalProfile(token: vscode.CancellationToken): Promise<vscode.TerminalProfile | undefined> {
        await this.auth.tryAutoConnect()

        const conn = isIamConnection(this.auth.activeConnection)
            ? this.auth.activeConnection
            : await promptForConnection(this.auth, 'iam')

        // User selected to edit credentials or add a new connection
        // We're not within a command, otherwise we'd throw an error here to signal cancellation
        if (!conn) {
            return
        }

        if (!isIamConnection(conn)) {
            throw new ToolkitError('No valid AWS IAM connection found.', { code: 'NoConnection' })
        }

        const validatedConn =
            this.auth.getConnectionState(conn) !== 'valid'
                ? ((await this.auth.reauthenticate(conn)) as unknown as IamConnection)
                : conn

        return new vscode.TerminalProfile({
            strictEnv: true,
            name: `AWS (${validatedConn.label})`,
            env: await injectCredentials(this.auth, validatedConn, 'TerminalProfile'),
            message: `Using AWS connection "${validatedConn.label}"`,
            isTransient: true,
        } as vscode.TerminalOptions)
    }

    public dispose(): void {
        vscode.Disposable.from(...this.#disposables).dispose()
        this.collection.clear()
    }

    private async handleUpdate(conn = this.auth.activeConnection) {
        // This will not work well with multiple users of `EnvironmentVariableCollection`
        this.collection.clear()
        if (!this.enabled) {
            return
        }

        if (conn?.state === 'valid' && isIamConnection(conn)) {
            await this.updateCollection(conn)
        }
    }

    private async updateCollection(conn: IamConnection): Promise<void> {
        const variables = await injectCredentials(this.auth, conn, 'AutomaticInjection', {})
        for (const [k, v] of Object.entries(variables)) {
            if (v !== undefined) {
                this.collection.replace(k, v)
            } else {
                this.collection.delete(k)
            }
        }
    }
}

export async function injectCredentials(
    auth: Auth,
    connection: IamConnection,
    source?: 'TerminalProfile' | 'AutomaticInjection',
    env = process.env
) {
    return telemetry.aws_injectCredentials.run(async () => {
        telemetry.record({ source, passive: true })

        const credentials = await connection.getCredentials()

        return {
            ...env,
            AWS_REGION: await auth.getDefaultRegion(connection),
            AWS_ACCESS_KEY_ID: credentials.accessKeyId,
            AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
            AWS_SESSION_TOKEN: credentials.sessionToken,
        }
    })
}
