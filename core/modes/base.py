import pandas as pd


def _get_attr_if_present(args, attr_name):
    """Safely get an attribute from args if present and truthy, else None."""
    return getattr(args, attr_name, None) or None


def collect_members(args, prefer="lab"):
    """
    Collect up to three member usernames from args, preferring lab or manual flags.

    Preference order:
      - if prefer == "lab": lab_usernameN first, else manual_usernameN first
      - fallback to the other set if preferred is missing
    """
    preferred_prefix = "lab" if prefer == "lab" else "manual"
    fallback_prefix = "manual" if prefer == "lab" else "lab"

    usernames = []
    for idx in (1, 2, 3):
        preferred = _get_attr_if_present(args, f"{preferred_prefix}_username{idx}")
        fallback = _get_attr_if_present(args, f"{fallback_prefix}_username{idx}")
        value = preferred or fallback
        if value:
            usernames.append(value)

    # Deduplicate while preserving order
    seen = set()
    unique_usernames = []
    for name in usernames:
        if name not in seen:
            seen.add(name)
            unique_usernames.append(name)

    return unique_usernames


def build_single_group_df(members, prefix):
    """
    Build a pandas DataFrame for a single group deployment.

    Columns:
      - Group ID: f"{prefix}_{members[0]}"
      - Member{i}: username value
    """
    if not members:
        return None

    data = {"Group ID": [f"{prefix}_{members[0]}"]}
    for i, member in enumerate(members, 1):
        data[f"Member{i}"] = [member]

    return pd.DataFrame(data)



