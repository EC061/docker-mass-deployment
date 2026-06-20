"""Executors: thin wrappers around system commands (zfs, docker, useradd, nvidia-smi).

Every executor returns a CommandResult instead of raising, so a failure never crashes the agent.
"""
